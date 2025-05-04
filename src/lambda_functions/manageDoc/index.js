// File: index.js
const { 
  S3Client,
  PutObjectCommand, 
  GetObjectCommand, 
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const busboy = require('busboy');

// Initialize the S3 client
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const BUCKET_NAME = process.env.BUCKET_NAME;
const ALLOWED_EXTENSIONS = ['.docx', '.pdf', '.jpg', '.png', '.jpeg', '.txt', '.xlsx'];

// Enhanced CORS headers function
function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // For production, use your specific domain
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Requested-With,Accept',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400', // 24 hours
  };
}

// Function to parse multipart form data
async function parseMultipartForm(event) {
  return new Promise((resolve, reject) => {
    // Check if content-type header exists
    const contentType = event.headers['content-type'] || event.headers['Content-Type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return reject(new Error('Not a multipart/form-data request'));
    }
    
    const bb = busboy({ 
      headers: event.headers,
      limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
      }
    });
    
    let fileData = null;
    let fileName = '';
    let fileType = '';
    
    bb.on('file', (fieldname, file, info) => {
      const { filename, encoding, mimeType } = info;
      console.log(`Processing file: ${filename}, type: ${mimeType}`);
      
      fileName = filename;
      fileType = mimeType;
      
      const chunks = [];
      file.on('data', (data) => {
        chunks.push(data);
      });
      
      file.on('end', () => {
        fileData = Buffer.concat(chunks);
        console.log(`File ${filename} read complete: ${fileData.length} bytes`);
      });
    });
    
    bb.on('finish', () => {
      if (!fileData) {
        return reject(new Error('No file found in form data'));
      }
      
      resolve({
        fileData,
        fileName,
        fileType
      });
    });
    
    bb.on('error', (error) => {
      console.error('Error parsing multipart form:', error);
      reject(error);
    });
    
    // Pass the base64-decoded body to busboy if it's base64 encoded
    if (event.isBase64Encoded) {
      bb.write(Buffer.from(event.body, 'base64'));
    } else {
      bb.write(Buffer.from(event.body));
    }
    
    bb.end();
  });
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
    
    // Route based on the action parameter from query string
    const action = event.queryStringParameters?.action;
    
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

// Updated file upload to S3 with multipart form parsing
async function uploadFile(event, headers) {
  console.log('Processing file upload request');
  
  try {
    // Parse the multipart form data
    const { fileData, fileName, fileType } = await parseMultipartForm(event);
    
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
    
    // Create a unique key for the file
    const key = `documents/${Date.now()}-${fileName}`;
    
    // Log details for debugging
    console.log(`Uploading file: ${fileName}, Content-Type: ${fileType}, Size: ${fileData.length} bytes`);
    
    // Upload file directly to S3
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileData,
      ContentType: fileType
    };
    
    const command = new PutObjectCommand(uploadParams);
    await s3Client.send(command);
    
    console.log(`File uploaded successfully to ${key}`);
    
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
    console.error('Error uploading file to S3:', error);
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
    
    // Convert the readable stream to buffer
    const fileStream = response.Body;
    const chunks = [];
    
    for await (const chunk of fileStream) {
      chunks.push(chunk);
    }
    
    const fileBuffer = Buffer.concat(chunks);
    
    // Set response headers for file download
    const downloadHeaders = {
      ...headers,
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Encoding': 'identity'
    };
    
    // Return file content directly, base64 encoded
    return {
      statusCode: 200,
      headers: downloadHeaders,
      body: fileBuffer.toString('base64'),
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