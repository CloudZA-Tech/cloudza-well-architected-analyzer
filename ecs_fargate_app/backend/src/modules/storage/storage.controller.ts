import {
    Controller,
    Get,
    Post,
    Delete,
    Param,
    Headers,
    HttpException,
    HttpStatus,
    Res,
    UseInterceptors,
    UploadedFile,
    UploadedFiles,
    Body,
} from '@nestjs/common';
import { Response } from 'express';
import { StorageService } from './storage.service';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { createHash } from 'crypto';
import { WorkItem } from '../../shared/interfaces/storage.interface';
import { FileUploadMode } from '../../shared/dto/analysis.dto';

@Controller('storage')
export class StorageController {
    constructor(
        private readonly storageService: StorageService,
        private readonly configService: ConfigService,
    ) { }

    private getUserId(email: string): string {
        return createHash('sha256').update(email).digest('hex');
    }

    private getUserEmail(userDataHeader: string): string | null {
        // Check if authentication is enabled
        const isAuthEnabled = this.configService.get<boolean>('auth.enabled', false);
        
        if (!isAuthEnabled) {
            // Return default "iac-analyzer" common profile when auth is disabled
            return 'iac-analyzer';
        }

        // Check if in development mode
        const isDevMode = this.configService.get<boolean>('auth.devMode', false);
        const devEmail = this.configService.get<string>('auth.devEmail');

        if (isDevMode && devEmail) {
            return devEmail;
        }

        // Production mode - parse from header
        if (!userDataHeader) {
            return null;
        }

        try {
            const userData = JSON.parse(
                Buffer.from(userDataHeader.split('.')[1], 'base64').toString(),
            );
            return userData.email;
        } catch (error) {
            return null;
        }
    }

    // Endpoint for supporting document upload
    @Post('work-items/upload-supporting')
    @UseInterceptors(FileInterceptor('file'))
    async uploadSupportingDocument(
        @UploadedFile() file: Express.Multer.File,
        @Body('description') description: string,
        @Body('mainFileId') mainFileId: string,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
    ) {
        try {
            const email = this.getUserEmail(userDataHeader);
            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }

            const userId = this.storageService.createUserIdHash(email);
            
            // Validate file size (4.5MB max)
            const MAX_SIZE = 4.5 * 1024 * 1024; // 4.5MB in bytes
            if (file.size > MAX_SIZE) {
                throw new HttpException(
                    'Supporting document exceeds maximum size of 4.5 MB',
                    HttpStatus.BAD_REQUEST,
                );
            }
            
            // Validate file type
            const validTypes = [
                'application/pdf', 
                'text/plain',
                'image/png',
                'image/jpeg'
            ];
            
            const fileExtension = file.originalname.split('.').pop()?.toLowerCase();
            if (fileExtension === 'txt' && !validTypes.includes(file.mimetype)) {
                file.mimetype = 'text/plain';
            } else if (!validTypes.includes(file.mimetype)) {
                throw new HttpException(
                    'Unsupported file type. Supported types: PDF, TXT, PNG, JPEG/JPG', 
                    HttpStatus.BAD_REQUEST,
                );
            }

            // Check if description is provided
            if (!description) {
                throw new HttpException(
                    'Description is required for supporting documents',
                    HttpStatus.BAD_REQUEST,
                );
            }
            
            // Check if mainFileId is provided
            if (!mainFileId) {
                throw new HttpException(
                    'Main file ID is required for supporting documents',
                    HttpStatus.BAD_REQUEST,
                );
            }

            // Verify that the main file exists
            try {
                await this.storageService.getWorkItem(userId, mainFileId);
            } catch (error) {
                throw new HttpException(
                    'Main file not found. Please upload a main file first.',
                    HttpStatus.BAD_REQUEST,
                );
            }

            const supportingDocId = await this.storageService.storeSupportingDocument(
                userId,
                mainFileId, // Pass the main file ID to use the same prefix
                file.originalname,
                file.mimetype,
                file.buffer,
                description
            );

            return { fileId: supportingDocId };
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to upload supporting document',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    // Endpoint to get supporting document content
    @Get('work-items/:fileId/supporting-document/:supportingDocId')
    async getSupportingDocument(
        @Param('fileId') fileId: string,
        @Param('supportingDocId') supportingDocId: string,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
        @Res() response: Response,
    ) {
        try {
            const email = this.getUserEmail(userDataHeader);
            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }
            const userId = this.getUserId(email);

            // Get the supporting document
            const { data, contentType, fileName } = await this.storageService.getSupportingDocument(
                userId, 
                fileId, 
                supportingDocId
            );

            // Set response headers
            response.setHeader('Content-Type', contentType);
            response.setHeader(
                'Content-Disposition',
                `attachment; filename="${fileName}"`
            );

            // Send the binary data directly
            response.end(data);
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to get supporting document',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Post('work-items/upload')
    @UseInterceptors(FileInterceptor('file'))
    async uploadFile(
        @UploadedFile() file: Express.Multer.File,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
    ) {
        try {
            const email = this.getUserEmail(userDataHeader);
            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }

            const userId = this.storageService.createUserIdHash(email);
            
            const workItem = await this.storageService.createWorkItem(
                userId,
                file.originalname,
                file.mimetype,
                file.buffer,
                FileUploadMode.SINGLE_FILE,
            );

            return { fileId: workItem.fileId };
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to upload file',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Post('work-items/upload-files')
    @UseInterceptors(FilesInterceptor('files'))
    async uploadMultipleFiles(
        @UploadedFiles() files: Express.Multer.File[],
        @Body('mode') mode: string,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
    ) {
        try {
            const email = this.getUserEmail(userDataHeader);
            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }

            const userId = this.storageService.createUserIdHash(email);
            const uploadMode = mode as FileUploadMode;
            
            if (!files || files.length === 0) {
                throw new HttpException('No files provided', HttpStatus.BAD_REQUEST);
            }

            // For SINGLE_FILE and ZIP_FILE modes, we expect only one file
            if ((uploadMode === FileUploadMode.SINGLE_FILE || uploadMode === FileUploadMode.ZIP_FILE) && files.length > 1) {
                throw new HttpException(
                    `Expected one file for ${uploadMode} mode, but received ${files.length}`,
                    HttpStatus.BAD_REQUEST
                );
            }

            // Process files based on mode
            let result: { fileId: string; tokenCount?: number; exceedsTokenLimit?: boolean };
            
            switch (uploadMode) {
                case FileUploadMode.SINGLE_FILE:
                    const workItem = await this.storageService.createWorkItem(
                        userId,
                        files[0].originalname,
                        files[0].mimetype,
                        files[0].buffer,
                        FileUploadMode.SINGLE_FILE
                    );
                    result = { fileId: workItem.fileId };
                    break;

                case FileUploadMode.MULTIPLE_FILES:
                    result = await this.storageService.handleMultipleFiles(
                        userId,
                        files.map(file => ({
                            filename: file.originalname,
                            buffer: file.buffer,
                            mimetype: file.mimetype
                        }))
                    );
                    break;

                case FileUploadMode.ZIP_FILE:
                    result = await this.storageService.handleZipFile(
                        userId,
                        files[0].originalname,
                        files[0].buffer
                    );
                    break;

                default:
                    throw new HttpException(`Unsupported upload mode: ${uploadMode}`, HttpStatus.BAD_REQUEST);
            }

            return result;
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to upload files',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Get('work-items')
    async listWorkItems(@Headers('x-amzn-oidc-data') userDataHeader: string) {
        try {
            const email = this.getUserEmail(userDataHeader);

            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }

            const userId = this.getUserId(email);

            return await this.storageService.listWorkItems(userId);
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to list work items',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Delete('work-items/:fileId')
    async deleteWorkItem(
        @Param('fileId') fileId: string,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
    ) {
        try {
            const email = this.getUserEmail(userDataHeader);
            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }
            const userId = this.getUserId(email);

            await this.storageService.deleteWorkItem(userId, fileId);
            return { message: 'Work item deleted successfully' };
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to delete work item',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Get('work-items/:fileId')
    async getWorkItem(
        @Param('fileId') fileId: string,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
    ): Promise<{
        workItem: WorkItem;
        content?: string;
        analysisResults?: any;
        iacDocument?: string;
        supportingDocument?: {
            id: string;
            name: string;
            description: string;
            type: string;
        };
    }> {
        try {
            const email = this.getUserEmail(userDataHeader);

            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }

            const userId = this.getUserId(email);

            const workItem = await this.storageService.getWorkItem(userId, fileId);
            const response: any = { workItem };

            // Get original content
            response.content = await this.storageService.getOriginalContent(
                userId,
                fileId,
            );

            // Get analysis results if completed
            if (workItem.analysisStatus === 'COMPLETED' || workItem.analysisStatus === 'PARTIAL') {
                response.analysisResults = await this.storageService.getAnalysisResults(
                    userId,
                    fileId,
                );
            }

            // Get IaC document if completed
            if (workItem.iacGenerationStatus === 'COMPLETED' || workItem.iacGenerationStatus === 'PARTIAL') {
                // Determine extension based on file type or template type
                const extension = workItem.fileType.includes('yaml') ? 'yaml' :
                    workItem.fileType.includes('json') ? 'json' : 'tf';

                response.iacDocument = await this.storageService.getIaCDocument(
                    userId,
                    fileId,
                    extension,
                    workItem,
                );
            }

            // Include supporting document info if available
            if (workItem.supportingDocumentAdded && workItem.supportingDocumentId) {
                response.supportingDocument = {
                    id: workItem.supportingDocumentId,
                    name: workItem.supportingDocumentName,
                    description: workItem.supportingDocumentDescription,
                    type: workItem.supportingDocumentType
                };
            }

            return response;
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to get work item',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Get('work-items/:fileId/content')
    async getWorkItemContent(
        @Param('fileId') fileId: string,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
        @Res() response: Response,
    ) {
        try {
            const email = this.getUserEmail(userDataHeader);
            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }
            const userId = this.getUserId(email);

            // First get the work item to get the file type
            const workItem = await this.storageService.getWorkItem(userId, fileId);

            // Get content with forDownload = true
            const { data, contentType } = await this.storageService.getOriginalContent(
                userId,
                fileId,
                true // It's for download
            );

            // Set response headers
            response.setHeader('Content-Type', contentType);
            response.setHeader(
                'Content-Disposition',
                `attachment; filename="${workItem.fileName}"`
            );

            // Send the binary data directly
            response.end(data);
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to get work item content',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Get('work-items/:fileId/analysis')
    async getWorkItemAnalysis(
        @Param('fileId') fileId: string,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
    ) {
        try {
            const email = this.getUserEmail(userDataHeader);
            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }
            const userId = this.getUserId(email);

            return await this.storageService.getAnalysisResults(userId, fileId);
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to get analysis results',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }

    @Get('work-items/:fileId/iac-document/:extension')
    async getWorkItemIaCDocument(
        @Param('fileId') fileId: string,
        @Param('extension') extension: string,
        @Headers('x-amzn-oidc-data') userDataHeader: string,
    ) {
        try {
            const email = this.getUserEmail(userDataHeader);
            if (!email) {
                throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
            }
            const userId = this.getUserId(email);

            return await this.storageService.getIaCDocument(userId, fileId, extension);
        } catch (error) {
            throw new HttpException(
                error.message || 'Failed to get IaC document',
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }
    }
}