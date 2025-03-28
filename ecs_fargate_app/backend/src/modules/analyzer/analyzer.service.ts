import { Injectable, Logger } from '@nestjs/common';
import { AwsConfigService } from '../../config/aws.config';
import {
    ConverseCommand,
    ContentBlock,
    Message,
    SystemContentBlock
} from '@aws-sdk/client-bedrock-runtime';
import { RetrieveCommand } from '@aws-sdk/client-bedrock-agent-runtime';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { paginateListAnswers, AnswerSummary } from '@aws-sdk/client-wellarchitected';
import { ConfigService } from '@nestjs/config';
import { AnalyzerGateway } from './analyzer.gateway';
import { IaCTemplateType } from '../../shared/dto/analysis.dto';
import { Subject } from 'rxjs';
import { AnalysisResult } from '../../shared/interfaces/analysis.interface';
import { StorageService } from '../storage/storage.service';
import * as Prompts from '../../prompts';
import { FileUploadMode } from '../../shared/dto/analysis.dto';


interface QuestionGroup {
    pillar: string;
    title: string;
    questionId: string;
    bestPractices: string[];
    bestPracticeIds: string[];
}

interface WellArchitectedBestPractice {
    Pillar: string;
    Question: string;
    questionId: string;
    'Best Practice': string;
    bestPracticeId: string;
}

interface BestPractice {
    name: string;
    applied: boolean;
    reasonApplied: string;
    reasonNotApplied: string;
    recommendations: string;
}

interface ModelResponse {
    bestPractices: BestPractice[];
}

interface WellArchitectedAnswer {
    AnswerSummaries: AnswerSummary[];
    WorkloadId: string;
    LensAlias?: string;
    LensArn?: string;
}

interface DocumentSection {
    content: string;
    order: number;
    description: string;
}

interface ModelSectionResponse {
    isComplete: boolean;
    sections: DocumentSection[];
}

@Injectable()
export class AnalyzerService {
    private readonly logger = new Logger(AnalyzerService.name);
    private cachedBestPractices: WellArchitectedBestPractice[] | null = null;
    private cancelGeneration$ = new Subject<void>();
    private cancelAnalysis$ = new Subject<void>();
    private readonly storageEnabled: boolean;

    constructor(
        private readonly awsConfig: AwsConfigService,
        private readonly configService: ConfigService,
        private readonly analyzerGateway: AnalyzerGateway,
        private readonly storageService: StorageService,
    ) {
        this.storageEnabled = this.configService.get<boolean>('storage.enabled', false);
    }

    private async getFileContent(userId: string, fileId: string): Promise<{ content: string; type: string }> {
        try {
            const workItem = await this.storageService.getWorkItem(userId, fileId);
            const { data, contentType: type } = await this.storageService.getOriginalContent(
                userId,
                fileId,
                false
            );
            // Convert Buffer to string or handle base64 data
            let content: string;
            if (Buffer.isBuffer(data)) {
                // If it's an image, convert to base64
                if (type.startsWith('image/')) {
                    content = `data:${type};base64,${data.toString('base64')}`;
                } else {
                    // For text files (IaC templates), convert to UTF-8 string
                    content = data.toString('utf-8');
                }
            } else {
                content = data;
            }

            return { content, type };
        } catch (error) {
            this.logger.error('Error fetching file content:', error);
            throw new Error('Failed to fetch file content from storage');
        }
    }

    private ensureBase64Format(fileContent: string, fileType: string): string {
        // If the content already starts with 'data:', it's already in the correct format
        if (fileContent.startsWith('data:')) {
            return fileContent;
        }

        // Convert Buffer/binary string to base64 and add data URI prefix
        try {
            // If it's a binary string, convert to base64
            const base64Content = Buffer.from(fileContent, 'binary').toString('base64');
            return `data:${fileType};base64,${base64Content}`;
        } catch (error) {
            this.logger.error('Error converting file content to base64:', error);
            throw new Error('Failed to process file content');
        }
    }

    private isImageFile(fileType: string | undefined): boolean {
        if (!fileType) return false;
        return fileType.startsWith('image/');
    }

    cancelAnalysis() {
        this.cancelAnalysis$.next();
    }

    async analyze(
        fileId: string,
        workloadId: string,
        selectedPillars: string[],
        uploadMode: FileUploadMode = FileUploadMode.SINGLE_FILE,
        userId?: string,
        supportingDocumentId?: string,
        supportingDocumentDescription?: string,
    ): Promise<{ results: AnalysisResult[]; isCancelled: boolean; error?: string; fileId?: string }> {
        const results: AnalysisResult[] = [];
        let workItem;

        try {
            if (!userId) {
                throw new Error('User ID is required for analysis');
            }

            // Get file content from storage
            const { content: fileContent, type: fileType } = await this.getFileContent(userId, fileId);

            // Get existing work item
            workItem = await this.storageService.getWorkItem(userId, fileId);

            // Get supporting document content if provided
            let supportingDocContent = null;
            let supportingDocType = null;
            let supportingDocName = null;

            if (supportingDocumentId) {
                try {
                    const supportingDoc = await this.storageService.getSupportingDocument(
                        userId,
                        fileId,
                        supportingDocumentId
                    );

                    // Convert to base64 for images and PDFs, leave as text for text files
                    if (supportingDoc.contentType === 'text/plain') {
                        supportingDocContent = supportingDoc.data.toString('utf8');
                    } else {
                        supportingDocContent = supportingDoc.data.toString('base64');
                    }

                    supportingDocType = supportingDoc.contentType;
                    supportingDocName = supportingDoc.fileName;

                    // Link the supporting document to the work item if not already linked
                    if (!workItem.supportingDocumentId) {
                        await this.storageService.linkSupportingDocumentToWorkItem(
                            userId,
                            fileId,
                            supportingDocumentId,
                            supportingDocName,
                            supportingDocType,
                            supportingDocumentDescription || ''
                        );
                    }
                } catch (error) {
                    this.logger.warn(`Failed to retrieve supporting document: ${error.message}. Continuing without it.`);
                }
            }

            await this.storageService.updateWorkItem(userId, fileId, {
                analysisStatus: 'IN_PROGRESS',
                analysisProgress: 0,
                lastModified: new Date().toISOString(),
            });

            // Load all best practices once
            await this.loadBestPractices(workloadId);

            // Pre-calculate question groups for all selected pillars
            const pillarQuestionGroups = await Promise.all(
                selectedPillars.map(pillar => this.retrieveBestPractices(pillar, workloadId))
            );

            // Calculate total questions
            const totalQuestions = pillarQuestionGroups.reduce(
                (sum, groups) => sum + groups.length,
                0
            );

            let processedQuestions = 0;

            // Create a Promise that resolves when cancelAnalysis$ emits
            const cancelPromise = new Promise<boolean>((resolve) => {
                const subscription = this.cancelAnalysis$.subscribe(() => {
                    subscription.unsubscribe();
                    resolve(true);
                });
            });

            // Process each pillar's questions
            for (let i = 0; i < selectedPillars.length; i++) {
                const pillar = selectedPillars[i];
                const questionGroups = pillarQuestionGroups[i];

                for (const question of questionGroups) {
                    try {
                        // Check for cancellation
                        const isCancelled = await Promise.race([
                            cancelPromise,
                            Promise.resolve(false),
                        ]);

                        if (isCancelled) {
                            if (workItem && results.length > 0) {
                                // Store partial results before marking as cancelled
                                await this.storageService.storeAnalysisResults(
                                    userId,
                                    workItem.fileId,
                                    results,
                                );

                                await this.storageService.updateWorkItem(userId, workItem.fileId, {
                                    analysisStatus: 'PARTIAL',
                                    analysisProgress: Math.round((processedQuestions / totalQuestions) * 100),
                                    analysisError: 'Analysis cancelled by user.',
                                    analysisPartialResults: true,
                                    lastModified: new Date().toISOString(),
                                });
                            }

                            this.analyzerGateway.emitAnalysisProgress({
                                processedQuestions,
                                totalQuestions,
                                currentPillar: pillar,
                                currentQuestion: 'Analysis cancelled',
                            });
                            return { results, isCancelled: true, fileId: workItem?.fileId };
                        }

                        let kbContexts: string[];
                        try {
                            kbContexts = await this.retrieveFromKnowledgeBase(
                                question.pillar,
                                question.title
                            );
                        } catch (error) {
                            if (workItem && results.length > 0) {
                                // Store partial results before marking as failed
                                await this.storageService.storeAnalysisResults(
                                    userId,
                                    workItem.fileId,
                                    results,
                                );

                                await this.storageService.updateWorkItem(userId, workItem.fileId, {
                                    analysisStatus: 'PARTIAL',
                                    analysisProgress: Math.round((processedQuestions / totalQuestions) * 100),
                                    analysisError: `Error retrieving from knowledge base: ${error}`,
                                    analysisPartialResults: true,
                                    lastModified: new Date().toISOString(),
                                });
                            }
                            return {
                                results,
                                isCancelled: false,
                                error: `Error retrieving from knowledge base. Analysis stopped. ${error}`,
                                fileId: workItem?.fileId
                            };
                        }

                        // Emit progress before processing
                        this.analyzerGateway.emitAnalysisProgress({
                            processedQuestions,
                            totalQuestions,
                            currentPillar: pillar,
                            currentQuestion: question.title,
                        });

                        try {
                            const analysis = await this.analyzeQuestion(
                                fileContent,
                                question,
                                kbContexts,
                                fileType,
                                uploadMode,
                                supportingDocContent,
                                supportingDocType,
                                supportingDocName,
                                supportingDocumentDescription
                            );
                            results.push(analysis);

                            // Update work item progress if storage is enabled
                            if (workItem) {
                                const progress = Math.round((processedQuestions / totalQuestions) * 100);
                                await this.storageService.updateWorkItem(userId, workItem.fileId, {
                                    analysisProgress: progress,
                                    lastModified: new Date().toISOString(),
                                });
                            }

                        } catch (error) {
                            if (workItem && results.length > 0) {
                                // Store partial results before marking as failed
                                await this.storageService.storeAnalysisResults(
                                    userId,
                                    workItem.fileId,
                                    results,
                                );

                                await this.storageService.updateWorkItem(userId, workItem.fileId, {
                                    analysisStatus: 'PARTIAL',
                                    analysisProgress: Math.round((processedQuestions / totalQuestions) * 100),
                                    analysisError: `${error}. Error analyzing question "${question.pillar} - ${question.title}". Analysis stopped, ${processedQuestions} questions where analyzed out of ${totalQuestions}.`,
                                    analysisPartialResults: true,
                                    lastModified: new Date().toISOString(),
                                });
                            }
                            return {
                                results,
                                isCancelled: false,
                                error: `${error}. Error analyzing question "${question.pillar} - ${question.title}". Analysis stopped, ${processedQuestions} questions where analyzed out of ${totalQuestions}.`,
                                fileId: workItem?.fileId
                            };
                        }

                        processedQuestions++;

                        // Emit progress after processing
                        this.analyzerGateway.emitAnalysisProgress({
                            processedQuestions,
                            totalQuestions,
                            currentPillar: pillar,
                            currentQuestion: question.title,
                        });
                    } catch (error) {
                        if (workItem && results.length > 0) {
                            // Store partial results before marking as failed
                            await this.storageService.storeAnalysisResults(
                                userId,
                                workItem.fileId,
                                results,
                            );

                            await this.storageService.updateWorkItem(userId, workItem.fileId, {
                                analysisStatus: 'PARTIAL',
                                analysisProgress: Math.round((processedQuestions / totalQuestions) * 100),
                                analysisError: error.message,
                                analysisPartialResults: true,
                                lastModified: new Date().toISOString(),
                            });
                        }
                        return {
                            results,
                            isCancelled: false,
                            error: 'Error processing question. Analysis stopped.',
                            fileId: workItem?.fileId
                        };
                    }
                }
            }

            // Store final results if storage is enabled
            if (workItem) {
                await this.storageService.storeAnalysisResults(
                    userId,
                    fileId,
                    results,
                );
                await this.storageService.updateWorkItem(userId, fileId, {
                    analysisStatus: 'COMPLETED',
                    analysisProgress: 100,
                    lastModified: new Date().toISOString(),
                });
            }

            return { results, isCancelled: false, fileId: workItem.fileId };
        } catch (error) {
            // Store partial results if available before marking as failed
            if (workItem && results.length > 0) {
                await this.storageService.storeAnalysisResults(
                    userId,
                    fileId,
                    results,
                );

                await this.storageService.updateWorkItem(userId, fileId, {
                    analysisStatus: 'PARTIAL',
                    analysisError: error.message,
                    analysisPartialResults: true,
                    lastModified: new Date().toISOString(),
                });
            }
            throw error;
        }
    }

    cancelIaCGeneration() {
        this.cancelGeneration$.next();
    }

    async generateIacDocument(
        fileId: string,
        recommendations: any[],
        templateType: IaCTemplateType,
        userId?: string,
    ): Promise<{ content: string; isCancelled: boolean; error?: string }> {
        try {

            if (!userId) {
                throw new Error('User ID is required for IaC generation');
            }

            // Get file content from storage
            const { content: fileContent, type: fileType } = await this.getFileContent(userId, fileId);
            const workItem = await this.storageService.getWorkItem(userId, fileId);

            if (!fileType.startsWith('image/')) {
                throw new Error('This operation is only supported for architecture diagrams');
            }

            await this.storageService.updateWorkItem(userId, fileId, {
                iacGenerationStatus: 'IN_PROGRESS',
                iacGenerationProgress: 0,
                lastModified: new Date().toISOString(),
            });

            let isComplete = false;
            let allSections: DocumentSection[] = [];
            let iteration = 0;

            // Ensure fileContent is in the correct base64 format
            const processedContent = this.ensureBase64Format(fileContent, fileType);

            // Extract base64 data and media type
            const base64Data = fileContent.split(',')[1];
            const mediaType = fileContent.split(';')[0].split(':')[1];

            while (!isComplete) {
                try {
                    const progress = Math.min(iteration * 10, 90);
                    this.analyzerGateway.emitImplementationProgress({
                        status: `Generating IaC document...`,
                        progress,
                    });

                    // Update storage progress if enabled
                    if (this.storageEnabled && userId && fileId) {
                        await this.storageService.updateWorkItem(userId, fileId, {
                            iacGenerationProgress: progress,
                            lastModified: new Date().toISOString(),
                        });
                    }

                    iteration++;

                    const response = await this.invokeBedrockModelForIacGeneration(
                        base64Data,
                        mediaType,
                        recommendations,
                        allSections.length,
                        allSections.length > 0 ? `${JSON.stringify(allSections, null, 2)}` : 'No previous sections generated yet',
                        templateType
                    );

                    // Handle cancellation and storage updates
                    if (response.isCancelled) {
                        const sortedSections = allSections.sort((a, b) => a.order - b.order);
                        const cancellationNote = '# Note: Template generation was cancelled. Below is a partial version.\n\n';
                        const partialContent = cancellationNote + sortedSections.map(section =>
                            `# ${section.description}\n${section.content}`
                        ).join('\n\n');

                        if (this.storageEnabled && userId && fileId && allSections.length > 0) {
                            const extension = templateType.includes('yaml') ? 'yaml' :
                                templateType.includes('json') ? 'json' : 'tf';

                            // Store partial content
                            await this.storageService.storeIaCDocument(
                                userId,
                                fileId,
                                partialContent,
                                extension,
                                templateType,
                            );

                            await this.storageService.updateWorkItem(userId, fileId, {
                                iacGenerationStatus: 'PARTIAL',
                                iacGenerationProgress: Math.round((allSections.length / 10) * 100), // Estimate progress
                                iacGenerationError: 'Generation cancelled by user',
                                iacPartialResults: true,
                                iacGeneratedFileType: templateType,
                                lastModified: new Date().toISOString(),
                            });
                        }

                        return {
                            content: partialContent || '',
                            isCancelled: true,
                        };
                    }

                    const { isComplete: batchComplete, sections } = this.parseImplementationModelResponse(response.content);
                    allSections.push(...sections);
                    isComplete = batchComplete;

                    // If we have sections but encounter an error, save partial results
                    if (!isComplete && allSections.length > 0) {
                        const sortedSections = allSections.sort((a, b) => a.order - b.order);
                        const partialContent = sortedSections.map(section =>
                            `# ${section.description}\n${section.content}`
                        ).join('\n\n');

                        if (this.storageEnabled && userId && fileId) {
                            const extension = templateType.includes('yaml') ? 'yaml' :
                                templateType.includes('json') ? 'json' : 'tf';

                            await this.storageService.storeIaCDocument(
                                userId,
                                fileId,
                                partialContent,
                                extension,
                                templateType,
                            );
                        }
                    }

                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    // Handle error and save partial results if available
                    if (this.storageEnabled && userId && fileId && allSections.length > 0) {
                        const sortedSections = allSections.sort((a, b) => a.order - b.order);
                        const errorNote = '# Note: Template generation encountered an error. Below is a partial version.\n\n';
                        const partialContent = errorNote + sortedSections.map(section =>
                            `# ${section.description}\n${section.content}`
                        ).join('\n\n');

                        const extension = templateType.includes('yaml') ? 'yaml' :
                            templateType.includes('json') ? 'json' : 'tf';

                        await this.storageService.storeIaCDocument(
                            userId,
                            fileId,
                            partialContent,
                            extension,
                            templateType,
                        );

                        await this.storageService.updateWorkItem(userId, fileId, {
                            iacGenerationStatus: 'PARTIAL',
                            iacGenerationProgress: Math.round((allSections.length / 10) * 100),
                            iacGenerationError: error.message,
                            iacPartialResults: true,
                            iacGeneratedFileType: templateType,
                            lastModified: new Date().toISOString(),
                        });

                        return {
                            content: partialContent,
                            isCancelled: false,
                            error: `Template generation encountered an error. Showing partial results. ${error}`
                        };
                    }
                    throw error;
                }
            }

            this.analyzerGateway.emitImplementationProgress({
                status: 'Finalizing IaC document...',
                progress: 100
            });

            const sortedSections = allSections.sort((a, b) => a.order - b.order);
            const content = sortedSections.map(section =>
                `# ${section.description}\n${section.content}`
            ).join('\n\n');

            // Store final results if storage is enabled
            if (this.storageEnabled && userId && fileId) {
                const extension = templateType.includes('yaml') ? 'yaml' :
                    templateType.includes('json') ? 'json' : 'tf';

                await this.storageService.storeIaCDocument(
                    userId,
                    fileId,
                    content,
                    extension,
                    templateType,
                );

                await this.storageService.updateWorkItem(userId, fileId, {
                    iacGenerationStatus: 'COMPLETED',
                    iacGenerationProgress: 100,
                    iacGeneratedFileType: templateType,
                    lastModified: new Date().toISOString(),
                });
            }

            return {
                content,
                isCancelled: false
            };

        } catch (error) {
            this.logger.error('Error generating IaC document:', error);
            if (userId && fileId) {
                await this.storageService.updateWorkItem(userId, fileId, {
                    iacGenerationStatus: 'FAILED',
                    iacGenerationError: error.message,
                    lastModified: new Date().toISOString(),
                });
            }
            throw new Error('Failed to generate IaC document');
        }
    }

    private parseImplementationModelResponse(content: string): ModelSectionResponse {
        const isComplete = content.includes('<end_of_iac_document_generation>');
        const cleanContent = content.replace('<end_of_iac_document_generation>', '').trim();

        // Split content into sections based on comments
        const sectionMatches = cleanContent.match(/#\s*Section\s*\d+.*?(?=#\s*Section|\s*$)/gs) || [];

        const sections: DocumentSection[] = sectionMatches.map(section => {
            const orderMatch = section.match(/^#\s*Section\s*(\d+)/);
            const descriptionMatch = section.match(/^#\s*Section\s*\d+\s*-\s*(.+?)\n/);
            const cleanedContent = section
                .replace(/^#\s*Section\s*\d+.*?\n/, '') // Remove section header
                .replace(/<message_truncated>\s*$/, '') // Remove <message_truncated> flag
                .trim();

            return {
                content: cleanedContent,
                order: orderMatch ? parseInt(orderMatch[1]) : 999,
                description: descriptionMatch ? descriptionMatch[1].trim() : 'Unnamed Section'
            };
        });

        return {
            isComplete,
            sections
        };
    }

    async getMoreDetails(
        selectedItems: any[],
        userId: string,
        fileId: string,
        templateType?: IaCTemplateType
    ): Promise<{ content: string; error?: string }> {
        const filteredItems = selectedItems.filter(item => !item.applied);
        try {
            if (!selectedItems || selectedItems.length === 0) {
                throw new Error('No items selected for detailed analysis');
            }

            if (!fileId || !userId) {
                throw new Error('File ID and User ID are required');
            }

            // Get file type from work item
            const workItem = await this.storageService.getWorkItem(userId, fileId);
            const fileType = workItem.fileType;

            if (!fileType) {
                throw new Error('No file type provided');
            }

            // Get the file content from storage
            const { data: fileContent } = await this.storageService.getOriginalContent(
                userId,
                fileId,
                false
            );

            // Get supporting document if available
            let supportingDocContent = null;
            let supportingDocType = null;
            let supportingDocName = null;
            let supportingDocDescription = null;

            if (workItem.supportingDocumentId && workItem.supportingDocumentAdded) {
                try {
                    const supportingDoc = await this.storageService.getSupportingDocument(
                        userId,
                        fileId,
                        workItem.supportingDocumentId
                    );

                    // Convert to base64 for images and PDFs, leave as text for text files
                    if (supportingDoc.contentType === 'text/plain') {
                        supportingDocContent = supportingDoc.data.toString('utf8');
                    } else {
                        supportingDocContent = supportingDoc.data.toString('base64');
                    }

                    supportingDocType = supportingDoc.contentType;
                    supportingDocName = supportingDoc.fileName;
                    supportingDocDescription = workItem.supportingDocumentDescription;
                } catch (error) {
                    this.logger.warn(`Failed to retrieve supporting document: ${error.message}. Continuing without it.`);
                }
            }

            // Convert Buffer to string if necessary and ensure proper format
            const processedContent = Buffer.isBuffer(fileContent)
                ? fileType.startsWith('image/')
                    ? `data:${fileType};base64,${fileContent.toString('base64')}`
                    : fileContent.toString('utf-8')
                : typeof fileContent === 'string' && fileType.startsWith('image/') && !fileContent.startsWith('data:')
                    ? `data:${fileType};base64,${fileContent}`
                    : fileContent;

            let allDetails = '';
            let hasError = false;
            const totalItems = filteredItems.length;
            const isImage = this.isImageFile(fileType);

            this.analyzerGateway.emitImplementationProgress({
                status: `Analyzing 1 of ${totalItems} selected best practices not applied - Best practice: '${filteredItems[0].name}'`,
                progress: 0
            });

            for (let i = 0; i < totalItems; i++) {
                try {
                    const item = filteredItems[i];

                    let itemDetails = '';
                    let isComplete = false;

                    while (!isComplete) {
                        let response;

                        if (isImage) {
                            // Invoke model for image details with supporting doc if available
                            const imageBase64Data = processedContent.split(',')[1];
                            const imageMediaType = processedContent.split(';')[0].split(':')[1];
                            const imageFormat = imageMediaType.split('/')[1]; // Extract format from media type

                            const messages: Message[] = [
                                {
                                    role: "user",
                                    content: [
                                        {
                                            image: {
                                                format: imageFormat as "png" | "jpeg" | "gif" | "webp",
                                                source: {
                                                    bytes: Buffer.from(imageBase64Data, 'base64')
                                                }
                                            }
                                        },
                                        {
                                            text: Prompts.buildImageDetailsPrompt(
                                                item,
                                                itemDetails,
                                                supportingDocName,
                                                supportingDocDescription
                                            )
                                        }
                                    ]
                                }
                            ];

                            // Add supporting document to messages if available
                            if (supportingDocContent && supportingDocType) {
                                if (supportingDocType === 'text/plain') {
                                    // For plain text
                                    messages[0].content.push({
                                        text: supportingDocContent
                                    });
                                } else if (supportingDocType.startsWith('image/')) {
                                    // For images
                                    const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                                    messages[0].content.push({
                                        image: {
                                            format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                                            source: {
                                                bytes: Buffer.from(supportingDocContent, 'base64')
                                            }
                                        }
                                    });
                                } else if (supportingDocType === 'application/pdf') {
                                    // For PDFs
                                    messages[0].content.push({
                                        document: {
                                            format: "pdf",
                                            name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                                            source: {
                                                bytes: Buffer.from(supportingDocContent, 'base64')
                                            }
                                        }
                                    });
                                }
                            }

                            const bedrockClient = this.awsConfig.createBedrockClient();
                            const modelId = this.configService.get<string>('aws.bedrock.modelId');

                            const command = new ConverseCommand({
                                modelId,
                                messages,
                                system: [
                                    {
                                        text: Prompts.buildImageDetailsSystemPrompt(templateType)
                                    }
                                ]
                            });

                            const modelResponse = await bedrockClient.send(command);
                            response = modelResponse;
                        } else {
                            // For non-image files, use the text-based approach with supporting doc if available
                            const detailsPrompt = Prompts.buildDetailsPrompt(
                                item,
                                processedContent,
                                itemDetails,
                                supportingDocName,
                                supportingDocDescription
                            );

                            const messages: Message[] = [
                                {
                                    role: "user",
                                    content: [
                                        {
                                            text: detailsPrompt
                                        }
                                    ]
                                }
                            ];

                            // Add supporting document to message content if available
                            if (supportingDocContent && supportingDocType) {
                                if (supportingDocType === 'text/plain') {
                                    // For plain text
                                    messages[0].content.push({
                                        text: supportingDocContent
                                    });
                                } else if (supportingDocType.startsWith('image/')) {
                                    // For images
                                    const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                                    messages[0].content.push({
                                        image: {
                                            format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                                            source: {
                                                bytes: Buffer.from(supportingDocContent, 'base64')
                                            }
                                        }
                                    });
                                } else if (supportingDocType === 'application/pdf') {
                                    // For PDFs
                                    messages[0].content.push({
                                        document: {
                                            format: "pdf",
                                            name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                                            source: {
                                                bytes: Buffer.from(supportingDocContent, 'base64')
                                            }
                                        }
                                    });
                                }
                            }

                            const bedrockClient = this.awsConfig.createBedrockClient();
                            const modelId = this.configService.get<string>('aws.bedrock.modelId');

                            const command = new ConverseCommand({
                                modelId,
                                messages,
                                system: [
                                    {
                                        text: Prompts.buildDetailsSystemPrompt()
                                    }
                                ]
                            });

                            const modelResponse = await bedrockClient.send(command);
                            response = modelResponse;
                        }

                        // Extract text from response output
                        const responseText = response.output.message.content.find(c => c.text)?.text || '';

                        const { content, isComplete: sectionComplete } =
                            this.parseDetailsModelResponse(responseText);

                        itemDetails += content;
                        isComplete = sectionComplete;

                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }

                    // Update progress
                    this.analyzerGateway.emitImplementationProgress({
                        status: `Analyzing ${i + 1} of ${totalItems} selected best practices not applied - Best practice: '${item.name}'`,
                        progress: Math.round(((i + 1) / totalItems) * 100)
                    });

                    allDetails += itemDetails + '\n\n---\n\n';
                } catch (error) {
                    this.logger.error(`Error analyzing item ${i + 1}:`, error);
                    hasError = true;
                    // Continue with next item instead of stopping completely
                    continue;
                }
            }

            this.analyzerGateway.emitImplementationProgress({
                status: 'Analysis complete',
                progress: 100
            });

            // If we have any details but also encountered errors
            if (allDetails && hasError) {
                return {
                    content: allDetails,
                    error: 'Some items could not be analyzed. Showing partial results.'
                };
            }

            // If we have no details at all
            if (!allDetails) {
                throw new Error('Failed to generate any detailed analysis');
            }

            return { content: allDetails.trim() };
        } catch (error) {
            this.logger.error('Error getting more details:', error);
            if (error instanceof Error) {
                throw error;
            }
            throw new Error('Failed to get detailed analysis');
        }
    }

    /**
     * Normalizes file names to comply with Bedrock API requirements:
     * - Only alphanumeric characters, whitespace, hyphens, parentheses, and square brackets
     * - No consecutive whitespace characters
     */
    private normalizeFileName(fileName: string): string {
        if (!fileName) return 'document.pdf';

        // Replace invalid characters with hyphens
        let normalizedName = fileName
            // Keep only allowed characters, replace others with hyphens
            .replace(/[^a-zA-Z0-9\s\-\(\)\[\]]/g, '-')
            // Replace consecutive whitespace with single space
            .replace(/\s+/g, ' ')
            // Trim leading/trailing spaces
            .trim();

        // If empty after normalization, use default name
        return normalizedName || 'document.pdf';
    }

    private parseDetailsModelResponse(content: string): { content: string; isComplete: boolean } {
        const isComplete = content.includes('<end_of_details_generation>');

        // Clean up the content
        let cleanContent = content
            .replace('<end_of_details_generation>', '')
            .replace('<details_truncated>', '')
            .trim();

        // If this isn't the final section, we need to find the last complete section
        if (!isComplete && cleanContent.includes('#')) {
            const sections = cleanContent.split(/(?=# )/);
            // Remove the last potentially incomplete section
            sections.pop();
            cleanContent = sections.join('');
        }

        return {
            content: cleanContent,
            isComplete
        };
    }

    private async retrieveFromKnowledgeBase(pillar: string, question: string) {
        const bedrockAgent = this.awsConfig.createBedrockAgentClient();
        const knowledgeBaseId = this.configService.get<string>('aws.bedrock.knowledgeBaseId');

        const command = new RetrieveCommand({
            knowledgeBaseId,
            retrievalQuery: {
                text: `For each best practice of the question "${question}" in the Well-Architected pillar "${pillar}" provide:
        - Recommendations
        - Best practices
        - Examples
        - Risks`,
            },
            retrievalConfiguration: {
                vectorSearchConfiguration: {
                    numberOfResults: 20,
                },
            },
        });

        const response = await bedrockAgent.send(command);
        return response.retrievalResults?.map(result => result.content?.text || '') || [];
    }

    private async analyzeQuestion(
        fileContent: string,
        question: QuestionGroup,
        kbContexts: string[],
        fileType: string,
        uploadMode: FileUploadMode = FileUploadMode.SINGLE_FILE,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string,
        supportingDocDescription?: string
    ): Promise<any> {
        try {
            // Determine if it's an image
            const isImage = uploadMode === FileUploadMode.SINGLE_FILE && fileType.startsWith('image/');

            // Choose the appropriate prompt based on uploadMode
            const prompt = isImage
                ? Prompts.buildImagePrompt(question, kbContexts, supportingDocName, supportingDocDescription)
                : uploadMode === FileUploadMode.SINGLE_FILE
                    ? Prompts.buildPrompt(question, kbContexts, supportingDocName, supportingDocDescription)
                    : Prompts.buildProjectPrompt(question, kbContexts, supportingDocName, supportingDocDescription);

            // Choose the appropriate system prompt based on uploadMode
            const systemPrompt = isImage
                ? Prompts.buildImageSystemPrompt(question)
                : uploadMode === FileUploadMode.SINGLE_FILE
                    ? Prompts.buildSystemPrompt(fileContent, question)
                    : Prompts.buildProjectSystemPrompt(fileContent, question);

            // Ensure fileContent is properly formatted for images
            if (isImage && !fileContent.startsWith('data:')) {
                this.logger.error('Invalid image content format');
                throw new Error('Invalid image content format');
            }

            const response = isImage
                ? await this.invokeBedrockModelWithImage(
                    prompt,
                    systemPrompt,
                    fileContent,
                    supportingDocContent,
                    supportingDocType,
                    supportingDocName
                )
                : await this.invokeBedrockModel(
                    prompt,
                    systemPrompt,
                    supportingDocContent,
                    supportingDocType,
                    supportingDocName
                );

            return {
                pillar: question.pillar,
                question: question.title,
                questionId: question.questionId,
                bestPractices: this.parseModelResponse(response, question),
            };
        } catch (error) {
            this.logger.error('Error analyzing question:', error);
            throw error;
        }
    }

    private cleanJsonString(jsonString: string): string {
        // First trim everything outside the outermost curly braces
        const firstCurlyBrace = jsonString.indexOf('{');
        const lastCurlyBrace = jsonString.lastIndexOf('}');

        if (firstCurlyBrace !== -1 && lastCurlyBrace !== -1) {
            jsonString = jsonString.substring(firstCurlyBrace, lastCurlyBrace + 1);
        }

        // Remove newlines and extra spaces
        jsonString = jsonString.replace(/\s+/g, " ");

        // Remove spaces after colons that are not within quotes
        jsonString = jsonString.replace(/(?<!"):\s+/g, ":");

        // Remove spaces before colons
        jsonString = jsonString.replace(/\s+:/g, ":");

        // Remove spaces after commas that are not within quotes
        jsonString = jsonString.replace(/(?<!"),\s+/g, ",");

        // Remove spaces before commas
        jsonString = jsonString.replace(/\s+,/g, ",");

        // Remove spaces after opening brackets and before closing brackets
        jsonString = jsonString.replace(/{\s+/g, "{");
        jsonString = jsonString.replace(/\s+}/g, "}");
        jsonString = jsonString.replace(/\[\s+/g, "[");
        jsonString = jsonString.replace(/\s+\]/g, "]");

        // Convert Python boolean values to JSON boolean values
        jsonString = jsonString.replace(/: True/g, ": true");
        jsonString = jsonString.replace(/: False/g, ": false");

        return jsonString;
    }

    private async invokeBedrockModelWithImage(
        prompt: string,
        systemPrompt: string,
        imageContent: string,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string
    ): Promise<ModelResponse> {
        const bedrockClient = this.awsConfig.createBedrockClient();
        const modelId = this.configService.get<string>('aws.bedrock.modelId');

        try {
            // Extract base64 data and media type from data URL
            const matches = imageContent.match(/^data:([^;]+);base64,(.+)$/);
            if (!matches) {
                throw new Error('Invalid image data format');
            }

            const [, imageMediaType, imageBase64Data] = matches;
            const imageFormat = imageMediaType.split('/')[1]; // Extract format from media type (e.g., "png" from "image/png")

            const messages: Message[] = [
                {
                    role: "user", // Using literal "user" as required by the API
                    content: [
                        {
                            image: {
                                format: imageFormat as "png" | "jpeg" | "gif" | "webp",
                                source: {
                                    bytes: Buffer.from(imageBase64Data, 'base64')
                                }
                            }
                        },
                        {
                            text: prompt
                        }
                    ]
                }
            ];

            // Add supporting document to message content if provided
            if (supportingDocContent && supportingDocType) {
                if (supportingDocType === 'text/plain') {
                    // For plain text
                    messages[0].content.push({
                        text: supportingDocContent
                    });
                } else if (supportingDocType.startsWith('image/')) {
                    // For images
                    const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                    messages[0].content.push({
                        image: {
                            format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                            source: {
                                bytes: Buffer.from(supportingDocContent, 'base64')
                            }
                        }
                    });
                } else if (supportingDocType === 'application/pdf') {
                    // For PDFs
                    messages[0].content.push({
                        document: {
                            format: "pdf",
                            name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                            source: {
                                bytes: Buffer.from(supportingDocContent, 'base64')
                            }
                        }
                    });
                }
            }

            // Prepare system content
            const system: SystemContentBlock[] = [
                {
                    text: systemPrompt
                }
            ];

            const command = new ConverseCommand({
                modelId,
                messages,
                system
            });

            const response = await bedrockClient.send(command);

            // Extract text from the response
            const responseText = response.output.message.content.find(c => c.text)?.text || '';

            const cleanedAnalysisJsonString = this.cleanJsonString(responseText);
            return JSON.parse(cleanedAnalysisJsonString);
        } catch (error) {
            this.logger.error('Error invoking Bedrock model:', error);
            throw new Error(`Failed to analyze diagram with AI model. Error invoking Bedrock model: ${error}`);
        }
    }

    private async invokeBedrockModel(
        prompt: string,
        systemPrompt: string,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string
    ): Promise<ModelResponse> {
        const bedrockClient = this.awsConfig.createBedrockClient();
        const modelId = this.configService.get<string>('aws.bedrock.modelId');

        // Prepare base message
        const messages: Message[] = [
            {
                role: "user",
                content: [
                    {
                        text: prompt
                    }
                ]
            }
        ];

        // Add supporting document to message content if provided
        if (supportingDocContent && supportingDocType) {
            if (supportingDocType === 'text/plain') {
                // For plain text
                messages[0].content.push({
                    text: supportingDocContent
                });
            } else if (supportingDocType.startsWith('image/')) {
                // For images
                const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                messages[0].content.push({
                    image: {
                        format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                        source: {
                            bytes: Buffer.from(supportingDocContent, 'base64')
                        }
                    }
                });
            } else if (supportingDocType === 'application/pdf') {
                // For PDFs
                messages[0].content.push({
                    document: {
                        format: "pdf",
                        name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                        source: {
                            bytes: Buffer.from(supportingDocContent, 'base64')
                        }
                    }
                });
            }
        }

        try {
            const command = new ConverseCommand({
                modelId,
                messages,
                system: [
                    {
                        text: systemPrompt
                    }
                ]
            });

            const response = await bedrockClient.send(command);

            // Extract text from response
            const responseText = response.output.message.content.find(c => c.text)?.text || '';

            const cleanedAnalysisJsonString = this.cleanJsonString(responseText);
            const parsedAnalysis = JSON.parse(cleanedAnalysisJsonString);

            return parsedAnalysis;
        } catch (error) {
            this.logger.error('Error invoking Bedrock model:', error);
            throw new Error(`Failed to analyze template with AI model. Error invoking Bedrock model: ${error}`);
        }
    }

    async invokeBedrockModelForIacGeneration(
        imageData: string,
        mediaType: string,
        recommendations: any[],
        previousSections: number,
        allPreviousSections: string,
        templateType?: IaCTemplateType,
        supportingDocContent?: string,
        supportingDocType?: string,
        supportingDocName?: string,
        supportingDocDescription?: string
    ): Promise<{ content: string; isCancelled: boolean }> {
        const bedrockClient = this.awsConfig.createBedrockClient();
        const modelId = this.configService.get<string>('aws.bedrock.modelId');

        const systemPrompt = Prompts.buildIacGenerationSystemPrompt(templateType);
        const prompt = Prompts.buildIacGenerationPrompt(
            previousSections,
            allPreviousSections,
            recommendations,
            supportingDocName,
            supportingDocDescription
        );

        const imageFormat = mediaType.split('/')[1]; // Extract format from media type

        const messages: Message[] = [
            {
                role: "user",
                content: [
                    {
                        image: {
                            format: imageFormat as "png" | "jpeg" | "gif" | "webp",
                            source: {
                                bytes: Buffer.from(imageData, 'base64')
                            }
                        }
                    },
                    {
                        text: prompt
                    }
                ]
            }
        ];

        // Add supporting document to message content if provided
        if (supportingDocContent && supportingDocType) {
            if (supportingDocType === 'text/plain') {
                // For plain text
                messages[0].content.push({
                    text: supportingDocContent
                });
            } else if (supportingDocType.startsWith('image/')) {
                // For images
                const supportingFormat = supportingDocType.split('/')[1]; // Extract format
                messages[0].content.push({
                    image: {
                        format: supportingFormat as "png" | "jpeg" | "gif" | "webp",
                        source: {
                            bytes: Buffer.from(supportingDocContent, 'base64')
                        }
                    }
                });
            } else if (supportingDocType === 'application/pdf') {
                // For PDFs
                messages[0].content.push({
                    document: {
                        format: "pdf",
                        name: this.normalizeFileName(supportingDocName || "supporting-document.pdf"),
                        source: {
                            bytes: Buffer.from(supportingDocContent, 'base64')
                        }
                    }
                });
            }
        }

        // Create a Promise that resolves when cancelGeneration$ emits
        const cancelPromise = new Promise<void>((resolve) => {
            const subscription = this.cancelGeneration$.subscribe(() => {
                subscription.unsubscribe();
                resolve();
            });
        });

        try {
            const command = new ConverseCommand({
                modelId,
                messages,
                system: [
                    {
                        text: systemPrompt
                    }
                ]
            });

            // Race between the Bedrock call and cancellation
            const modelResponsePromise = bedrockClient.send(command);
            const raceResult = await Promise.race([
                modelResponsePromise,
                cancelPromise.then(() => null)
            ]);

            if (!raceResult) {
                // Cancelled
                return {
                    content: allPreviousSections,
                    isCancelled: true
                };
            }

            // Not cancelled, process normal response
            const responseText = raceResult.output.message.content.find(c => c.text)?.text || '';

            return {
                content: responseText,
                isCancelled: false
            };
        } catch (error) {
            this.logger.error('Error invoking Bedrock model:', error);
            throw new Error(`Failed to generate IaC document. Error invoking Bedrock model: ${error}`);
        }
    }

    private parseModelResponse(response: ModelResponse, questionGroup: QuestionGroup): any[] {
        try {
            return response.bestPractices.map((bp: BestPractice, index: number) => ({
                id: questionGroup.bestPracticeIds[index],
                name: bp.name,
                applied: bp.applied,
                reasonApplied: bp.reasonApplied,
                reasonNotApplied: bp.reasonNotApplied,
                recommendations: bp.recommendations,
            }));
        } catch (error) {
            this.logger.error('Error parsing model response:', error);
            throw new Error('Failed to parse analysis results');
        }
    }

    private async loadWellArchitectedAnswers(workloadId: string): Promise<WellArchitectedAnswer> {
        const waClient = this.awsConfig.createWAClient();

        try {
            const allAnswers: WellArchitectedAnswer = {
                AnswerSummaries: [],
                WorkloadId: workloadId,
            };

            const paginator = paginateListAnswers(
                { client: waClient },
                {
                    WorkloadId: workloadId,
                    LensAlias: 'wellarchitected'
                }
            );

            // Iterate through all pages
            for await (const page of paginator) {
                if (page.AnswerSummaries) {
                    allAnswers.AnswerSummaries.push(...page.AnswerSummaries);
                }

                // Set LensAlias and LensArn from the page response
                if (page.LensAlias) {
                    allAnswers.LensAlias = page.LensAlias;
                }
                if (page.LensArn) {
                    allAnswers.LensArn = page.LensArn;
                }
            }

            return allAnswers;
        } catch (error) {
            this.logger.error('Error fetching Well-Architected answers:', error);
            throw new Error('Failed to fetch Well-Architected answers');
        }
    }

    // Load best practices once
    private async loadBestPractices(workloadId: string): Promise<WellArchitectedBestPractice[]> {
        if (this.cachedBestPractices) {
            return this.cachedBestPractices;
        }

        const s3Client = this.awsConfig.createS3Client();
        const waDocsBucket = this.configService.get<string>('aws.s3.waDocsBucket');

        try {
            // Fetch best practices from S3
            const s3Response = await s3Client.send(
                new GetObjectCommand({
                    Bucket: waDocsBucket,
                    Key: 'well_architected_best_practices.json'
                })
            );

            const responseBody = await s3Response.Body?.transformToString();
            if (!responseBody) {
                throw new Error('No data received from S3');
            }

            const baseBestPractices: WellArchitectedBestPractice[] = JSON.parse(responseBody);

            // Fetch WA Tool answers
            const waAnswers = await this.loadWellArchitectedAnswers(workloadId);

            // Create mappings for both ChoiceIds and QuestionIds
            const choiceIdMapping = new Map<string, string>();
            const questionIdMapping = new Map<string, string>();

            waAnswers.AnswerSummaries.forEach(answer => {
                // Map QuestionId to Question Title
                questionIdMapping.set(answer.QuestionTitle, answer.QuestionId);

                // Map Choice Titles to ChoiceIds
                answer.Choices?.forEach(choice => {
                    if (choice.Title && choice.ChoiceId) {
                        // Create a unique key combining question and choice (for cases of WA questions with same BP title)
                        const uniqueKey = `${answer.QuestionTitle}|||${choice.Title}`;
                        choiceIdMapping.set(uniqueKey, choice.ChoiceId);
                    }
                });
            });

            // Enhance best practices with their corresponding ChoiceIds and QuestionIds
            this.cachedBestPractices = baseBestPractices.map(bp => {
                // Create the same unique key for lookup
                const uniqueKey = `${bp.Question}|||${bp['Best Practice']}`;

                return {
                    ...bp,
                    bestPracticeId: choiceIdMapping.get(uniqueKey) ||
                        this.generateFallbackBestPracticeId(`${bp.Question}-${bp['Best Practice']}`),
                    questionId: questionIdMapping.get(bp.Question) ||
                        this.generateFallbackBestPracticeId(bp.Question)
                };
            });

            return this.cachedBestPractices;
        } catch (error) {
            this.logger.error('Error loading best practices:', error);
            throw new Error('Failed to load Well-Architected best practices');
        }
    }

    private async retrieveBestPractices(pillarId: string, workloadId: string): Promise<QuestionGroup[]> {
        try {
            const allBestPractices = await this.loadBestPractices(workloadId);
            const pillarBestPractices = allBestPractices.filter(
                bp => bp.Pillar.toLowerCase().replace(/\s+/g, '-') === pillarId
            );

            const questionGroups = new Map<string, {
                practices: Array<{ practice: string, id: string }>,
                questionId: string
            }>();

            pillarBestPractices.forEach(bp => {
                if (!questionGroups.has(bp.Question)) {
                    questionGroups.set(bp.Question, {
                        practices: [],
                        questionId: bp.questionId
                    });
                }
                questionGroups.get(bp.Question)?.practices.push({
                    practice: bp['Best Practice'],
                    id: bp.bestPracticeId
                });
            });

            return Array.from(questionGroups.entries()).map(([question, data]) => ({
                pillar: pillarBestPractices[0].Pillar,
                title: question,
                questionId: data.questionId,
                bestPractices: data.practices.map(p => p.practice),
                bestPracticeIds: data.practices.map(p => p.id)
            }));
        } catch (error) {
            this.logger.error('Error retrieving best practices:', error);
            throw new Error('Failed to retrieve Well-Architected best practices');
        }
    }

    private generateFallbackBestPracticeId(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }
}