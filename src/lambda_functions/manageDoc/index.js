// File: index.js
const { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  ListObjectsV2Command, 
  HeadObjectCommand 
} = require('@aws-sdk/client-s3');

// Initialize the S3 client
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET_NAME = process.env.BUCKET_NAME;
const ALLOWED_EXTENSIONS = ['.docx', '.pdf', '.jpg', '.png', '.jpeg', '.txt', '.xlsx'];

// Enhanced CORS headers function for Lambda
function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // For production, use your specific domain
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Requested-With,Accept',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400', // 24 hours
  };
}

// Main handler to route requests based on action
exports.handler = async (event) => {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));
    // Get CORS headers
    const headers = getCorsHeaders();
    
    // Special handling for OPTIONS requests (preflight)
    if (event.httpMethod === 'OPTIONS') {
      console.log('Handling OPTIONS preflight request');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Preflight request successful' }),
      };
    }    
    
    // Parse the request body if it exists
    let body = {};
    if (event.body) {
      try {
        // Check if the body is base64 encoded (binary data)
        if (event.isBase64Encoded) {
          // For binary uploads, we'll handle them in the uploadFile function
          body = { action: 'uploadFile' };
        } else {
          // For JSON requests
          body = JSON.parse(event.body);
        }
      } catch (error) {
        console.error('Error parsing request body:', error);
        // If we can't parse as JSON and it's not marked as base64, assume it's a direct file upload
        body = { action: 'uploadFile' };
      }
    }
    
    // Route based on the action parameter
    const action = event.queryStringParameters?.action || body.action;
    
    switch (action) {
      case 'uploadFile':
        return await uploadFile(event, headers);
      case 'listDocuments':
        return await listDocuments(headers);
      case 'downloadFile':
        return await downloadFile(event, headers);
      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid action specified' }),
        };
    }
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error', details: error.message }),
    };
  }
};

// Direct file upload to S3
async function uploadFile(event, headers) {
  if (!event.isBase64Encoded || !event.body) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid file upload request' }),
    };
  }

  // Get file info from query parameters
  const fileName = event.queryStringParameters?.fileName;
  const contentType = event.queryStringParameters?.contentType || 'application/octet-stream';
  
  if (!fileName) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'File name is required' }),
    };
  }
  
  // Validate file extension
  const fileExtension = `.${fileName.split('.').pop().toLowerCase()}`;
  if (!ALLOWED_EXTENSIONS.includes(fileExtension)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ 
        error: 'Invalid file type', 
        message: `Supported file types: ${ALLOWED_EXTENSIONS.join(', ')}` 
      }),
    };
  }

  // Decode base64 file data
  const fileBuffer = Buffer.from(event.body, 'base64');
  
  // Create a unique key for the file
  const key = `documents/${Date.now()}-${fileName}`;
  
  // Upload file directly to S3
  const uploadParams = {
    Bucket: BUCKET_NAME,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType
  };
  
  try {
    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'File uploaded successfully',
        key,
        fileName
      }),
    };
  } catch (error) {
    console.error('Error uploading file:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to upload file', details: error.message }),
    };
  }
}

// List all documents in the bucket
async function listDocuments(headers) {
  const command = new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
    Prefix: 'documents/'
  });
  
  const response = await s3Client.send(command);
  
  const documents = response.Contents ? response.Contents.map(item => {
    // Extract the filename from the key
    const key = item.Key;
    const fileName = key.split('/').pop();
    
    return {
      key: item.Key,
      fileName,
      size: item.Size,
      lastModified: item.LastModified,
    };
  }) : [];
  
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ documents }),
  };
}

// Direct file download from S3
async function downloadFile(event, headers) {
  const key = event.queryStringParameters?.key;
  
  if (!key) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Document key is required' }),
    };
  }
  
  try {
    // Fetch the file from S3
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });
    
    const response = await s3Client.send(command);
    
    // Convert the readable stream to buffer
    const fileStream = response.Body;
    const chunks = [];
    
    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }
    
    const fileBuffer = Buffer.concat(chunks);
    const base64File = fileBuffer.toString('base64');
    
    // Extract file name from key
    const fileName = key.split('/').pop();
    
    // Set content type based on file extension
    const extension = fileName.split('.').pop().toLowerCase();
    let contentType = 'application/octet-stream'; // Default
    
    switch (extension) {
      case 'pdf':
        contentType = 'application/pdf';
        break;
      case 'docx':
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        break;
      case 'xlsx':
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        break;
      case 'txt':
        contentType = 'text/plain';
        break;
      case 'jpg':
      case 'jpeg':
        contentType = 'image/jpeg';
        break;
      case 'png':
        contentType = 'image/png';
        break;
    }
    
    // Set response headers for file download
    const downloadHeaders = {
      ...headers,
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
    };
    
    return {
      statusCode: 200,
      headers: downloadHeaders,
      body: base64File,
      isBase64Encoded: true
    };
  } catch (error) {
    console.error('Error downloading file:', error);
    
    if (error.name === 'NoSuchKey') {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Document not found' }),
      };
    }
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to download file', details: error.message }),
    };
  }
}