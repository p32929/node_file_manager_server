const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Create temp directory for chunk uploads
const TEMP_DIR = path.join(os.tmpdir(), 'file-server-chunks');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// CORS headers for cross-tab uploads
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-File-Name, X-Chunk-Index, X-Total-Chunks, X-File-Path, Content-Disposition, Content-Range');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Middleware for parsing JSON and serving static files
app.use(express.json());
app.use(express.static('public'));

// Middleware for file uploads
app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  abortOnLimit: true,
  useTempFiles: true,
  tempFileDir: os.tmpdir()
}));

// Root endpoint - serve index.html
app.get('/', (req, res) => {
  fs.readFile('./public/index.html', (err, data) => {
    if (err) return res.status(500).send('Error loading HTML');
    res.setHeader('Content-Type', 'text/html');
    res.send(data);
  });
});

// List drives endpoint (Windows only)
app.get('/list-drives', (req, res) => {
  if (process.platform === 'win32') {
    exec('wmic logicaldisk get name', (error, stdout) => {
      if (error) {
        return res.status(500).json({ error: error.message });
      }
      
      // Parse the output to get drive letters
      const drives = stdout.split('\r\r\n')
        .map(line => line.trim())
        .filter(line => /^[A-Za-z]:$/.test(line))
        .map(drive => drive + '\\');
      
      res.json({ drives });
    });
  } else {
    // For non-Windows systems, just return root
    res.json({ drives: ['/'] });
  }
});

// List folders endpoint
app.get('/list-folders', (req, res) => {
  let currentPath = req.query.path || '/';
  
  // If we're at the root on Windows, redirect to the drive list
  if ((currentPath === '/' || currentPath === '\\') && process.platform === 'win32') {
    return res.json({ 
      path: '/', 
      folders: [],
      isRoot: true
    });
  }
  
  try {
    currentPath = path.resolve(currentPath); // clean path
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    const folders = entries
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    res.json({ path: currentPath, folders });
  } catch (err) {
    res.json({ path: '/', folders: [], error: err.message });
  }
});

// Traditional file upload endpoint
app.post('/upload', (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).send('No file uploaded');
  }
  
  const file = req.files.file;
  const targetPath = req.body.targetPath || getCurrentPath();
  
  // Create upload directory if it doesn't exist
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
  
  const uploadPath = path.join(targetPath, file.name);
  
  file.mv(uploadPath, (err) => {
    if (err) {
      return res.status(500).send(err);
    }
    
    res.send(`File uploaded to ${uploadPath}`);
  });
});

// New endpoint for chunk uploads
app.post('/upload-chunk', async (req, res) => {
  try {
    // Extract metadata from headers
    const fileName = req.headers['x-file-name'];
    const chunkIndex = parseInt(req.headers['x-chunk-index']);
    const totalChunks = parseInt(req.headers['x-total-chunks']);
    const targetPath = req.headers['x-file-path'] || getCurrentPath();
    
    if (isNaN(chunkIndex) || isNaN(totalChunks)) {
      return res.status(400).send('Invalid chunk information');
    }
    
    // Create unique ID based on filename and total chunks
    const fileId = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const chunkDir = path.join(TEMP_DIR, fileId);
    
    // Create directory for this file's chunks if it doesn't exist
    if (chunkIndex === 0 && fs.existsSync(chunkDir)) {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    }
    
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }
    
    // Write chunk to temporary file
    const chunkFilePath = path.join(chunkDir, `chunk-${chunkIndex}`);
    
    // Get raw body data
    let data = [];
    req.on('data', chunk => {
      data.push(chunk);
    });
    
    req.on('end', async () => {
      const buffer = Buffer.concat(data);
      
      // Write chunk to disk
      fs.writeFileSync(chunkFilePath, buffer);
      
      // Check if this was the last chunk
      const files = fs.readdirSync(chunkDir).filter(file => file.startsWith('chunk-'));
      
      if (files.length === totalChunks) {
        // All chunks received, combine them
        const outputDir = path.resolve(targetPath);
        
        // Create upload directory if it doesn't exist
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const finalFilePath = path.join(outputDir, fileName);
        const writeStream = fs.createWriteStream(finalFilePath);
        
        // Combine all chunks in order
        for (let i = 0; i < totalChunks; i++) {
          const chunkPath = path.join(chunkDir, `chunk-${i}`);
          if (fs.existsSync(chunkPath)) {
            const chunkData = fs.readFileSync(chunkPath);
            writeStream.write(chunkData);
          } else {
            console.error(`Missing chunk ${i} for file ${fileName}`);
          }
        }
        
        writeStream.end();
        
        // Clean up temporary files
        setTimeout(() => {
          try {
            fs.rmSync(chunkDir, { recursive: true, force: true });
          } catch (error) {
            console.error('Error cleaning up chunks:', error);
          }
        }, 1000);
        
        res.status(200).send('File upload complete');
      } else {
        // More chunks expected
        res.status(200).send('Chunk received');
      }
    });
  } catch (error) {
    console.error('Error in chunk upload:', error);
    res.status(500).send('Server error during upload');
  }
});

// Helper function to get current path
function getCurrentPath() {
  return process.cwd();
}

// Start the server
const server = app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
