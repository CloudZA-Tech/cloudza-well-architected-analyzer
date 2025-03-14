import React, { useState } from 'react';
import {
    FormField,
    SpaceBetween,
    Alert,
    StatusIndicator,
    FileUpload as CloudscapeFileUpload,
    Input,
    Button,
} from '@cloudscape-design/components';
import { UploadedFile } from '../types';
import { HelpButton } from './utils/HelpButton';
import { storageApi } from '../services/storage';

interface SupportingDocumentUploadProps {
    onDocumentUploaded: (file: UploadedFile, description: string, fileId: string) => void;
    onUploadStatusChange?: (isUploading: boolean) => void;
    disabled?: boolean;
    activeWorkItemId?: string;
}

// Maximum file size: 4.5 MB in bytes
const MAX_FILE_SIZE = 4.5 * 1024 * 1024;

export const SupportingDocumentUpload: React.FC<SupportingDocumentUploadProps> = ({
    onDocumentUploaded,
    onUploadStatusChange,
    disabled = false,
    activeWorkItemId
}) => {
    const [value, setValue] = useState<File[]>([]);
    const [description, setDescription] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState<'initial' | 'success' | 'error'>('initial');

    const acceptedFileTypes = ['.pdf', '.txt', '.png', '.jpg', '.jpeg'];

    const handleFileChange = async (files: File[]) => {
        setValue(files);
        setError(null);

        if (!files.length) {
            return;
        }

        const file = files[0]; // Only accept a single file

        // Check file size
        if (file.size > MAX_FILE_SIZE) {
            setError(`File is too large. Maximum file size is 4.5 MB.`);
            return;
        }

        // Validate file type
        const extension = `.${file.name.split('.').pop()?.toLowerCase()}`;
        if (!acceptedFileTypes.includes(extension)) {
            setError(`File type not supported. Supported types: ${acceptedFileTypes.join(', ')}`);
            return;
        }
    };

    const handleUpload = async () => {
        if (!value.length) {
            setError('Please select a file to upload.');
            return;
        }

        if (!description.trim()) {
            setError('Please provide a description for the supporting document.');
            return;
        }

        // Check if we have a main file ID
        if (!activeWorkItemId) {
            setError('Please upload a main file first before adding a supporting document.');
            return;
        }

        try {
            setIsUploading(true);
            // Notify parent component that upload is starting
            if (onUploadStatusChange) onUploadStatusChange(true);

            // Create FormData
            const formData = new FormData();
            formData.append('file', value[0]);
            formData.append('description', description);
            formData.append('mainFileId', activeWorkItemId); // Pass the main file ID

            // Upload the file
            const response = await storageApi.uploadSupportingDocument(formData);

            if (!response || !response.fileId) {
                throw new Error('Invalid server response');
            }

            // Determine file type
            const file = value[0];
            const fileType = determineFileType(file);

            // Create uploaded file object
            const uploadedFile: UploadedFile = {
                name: file.name,
                content: '', // Content is stored in S3
                type: fileType,
                size: file.size,
            };

            setUploadStatus('success');
            onDocumentUploaded(uploadedFile, description, response.fileId);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to upload file');
            setUploadStatus('error');
        } finally {
            setIsUploading(false);
            // Notify parent component that upload is complete
            if (onUploadStatusChange) onUploadStatusChange(false);
        }
    };

    const determineFileType = (file: File): string => {
        // Handle specific file types
        if (file.name.endsWith('.pdf')) return 'application/pdf';
        if (file.name.endsWith('.txt')) return 'text/plain';

        // For standard MIME types
        return file.type;
    };

    return (
        <SpaceBetween size="l">
            <FormField
                label={
                    <>
                        Supporting Document <HelpButton contentId="supportingDocument" />
                    </>
                }
                description={`Upload a single supporting document to provide additional context for your analysis. Supported types: ${acceptedFileTypes.join(' ')}`}
                errorText={error}
            >
                <SpaceBetween size="s">
                    <CloudscapeFileUpload
                        onChange={({ detail }) => handleFileChange(detail.value)}
                        value={value}
                        accept={acceptedFileTypes.join(',')}
                        i18nStrings={{
                            uploadButtonText: () => isUploading ? 'Uploading...' : 'Choose Supporting Document',
                            dropzoneText: () => isUploading ? 'Uploading...' : 'Drop file to upload',
                            removeFileAriaLabel: i => `Remove ${i + 1}`,
                        }}
                        showFileLastModified
                        showFileSize
                        multiple={false}
                        tokenLimit={1}
                    />

                    <FormField>
                        <Input
                            value={description}
                            onChange={({ detail }) => setDescription(detail.value)}
                            placeholder="Enter a brief description of the supporting document's content"
                            disabled={disabled || isUploading}
                        />
                    </FormField>

                    <Button
                        onClick={handleUpload}
                        disabled={disabled || isUploading || value.length === 0 || !description.trim()}
                        iconName="upload"
                        variant="primary"
                        loading={isUploading}
                    >
                        Upload Supporting Document
                    </Button>

                    {uploadStatus === 'success' && !isUploading && (
                        <StatusIndicator type="success">
                            Document uploaded successfully
                        </StatusIndicator>
                    )}
                </SpaceBetween>
            </FormField>

            {error && (
                <Alert
                    type="error"
                    dismissible
                    onDismiss={() => setError(null)}
                    header="Error uploading document"
                >
                    {error}
                </Alert>
            )}
        </SpaceBetween>
    );
};