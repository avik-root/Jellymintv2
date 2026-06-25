import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize .env file if it doesn't exist
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
  console.log('.env file not found. Creating a secure configuration...');
  const key = crypto.randomBytes(32).toString('hex');
  const envExamplePath = path.join(__dirname, '.env.example');
  
  if (fs.existsSync(envExamplePath)) {
    let content = fs.readFileSync(envExamplePath, 'utf8');
    content = content.replace('ENCRYPTION_KEY=', `ENCRYPTION_KEY=${key}`);
    fs.writeFileSync(envPath, content, 'utf8');
  } else {
    fs.writeFileSync(
      envPath,
      `PORT=3000\nOLLAMA_HOST=http://127.0.0.1:11434\nENCRYPTION_KEY=${key}\n`,
      'utf8'
    );
  }
}

dotenv.config();

const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
  console.error('Error: ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Basic CPU tracking
let previousCpuTime = { idle: 0, total: 0 };
function getCpuUsage() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type];
    }
    idle += cpu.times.idle;
  }
  
  if (previousCpuTime.total === 0) {
    previousCpuTime = { idle, total };
    return 0; // First call
  }
  
  const idleDiff = idle - previousCpuTime.idle;
  const totalDiff = total - previousCpuTime.total;
  previousCpuTime = { idle, total };
  
  if (totalDiff === 0) return 0;
  return 100 - Math.floor((idleDiff / totalDiff) * 100);
}
// Init the cpu time
getCpuUsage();

app.get('/api/sysinfo', (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const ramPercent = Math.floor((usedMem / totalMem) * 100);
  
  const cpuPercent = getCpuUsage();
  
  res.json({ cpu: cpuPercent, ram: ramPercent });
});

// Encryption settings
const ALGORITHM = 'aes-256-gcm';
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.enc');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper to encrypt
function encrypt(text, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag().toString('hex');
  
  return {
    iv: iv.toString('hex'),
    tag: tag,
    ciphertext: encrypted
  };
}

// Helper to decrypt
function decrypt(encryptedObj, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(encryptedObj.iv, 'hex');
  const tag = Buffer.from(encryptedObj.tag, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encryptedObj.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// Chatbot Metadata API
app.get('/api/version', (req, res) => {
  res.json({
    name: 'Jellymint',
    version: 'v2.0.0'
  });
});

// Get Encrypted Chat History
app.get('/api/history', (req, res) => {
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      return res.json([]);
    }
    const rawData = fs.readFileSync(HISTORY_FILE, 'utf8');
    const encryptedObj = JSON.parse(rawData);
    const decryptedText = decrypt(encryptedObj, ENCRYPTION_KEY);
    return res.json(JSON.parse(decryptedText));
  } catch (error) {
    console.error('Error decrypting history:', error.message);
    return res.status(500).json({ 
      error: 'Failed to decrypt chat history.', 
      details: 'Encryption key mismatch or file corruption.' 
    });
  }
});

// Save Encrypted Chat History
app.post('/api/history', (req, res) => {
  try {
    const chatData = req.body;
    const textToEncrypt = JSON.stringify(chatData);
    const encryptedObj = encrypt(textToEncrypt, ENCRYPTION_KEY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(encryptedObj), 'utf8');
    return res.json({ success: true });
  } catch (error) {
    console.error('Error encrypting/saving history:', error);
    return res.status(500).json({ error: 'Failed to encrypt and save history.' });
  }
});

// Proxy route to get available local Ollama models
app.get('/api/models', async (req, res) => {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama status: ${response.status}`);
    }
    const data = await response.json();
    return res.json({ models: data.models || [], online: true });
  } catch (error) {
    console.warn('Ollama offline or tags endpoint error:', error.message);
    return res.json({ 
      models: [], 
      online: false, 
      error: 'Ollama is offline or unreachable.' 
    });
  }
});

// Proxy route to stream response from local Ollama model
app.post('/api/chat', async (req, res) => {
  const { model, messages } = req.body;
  
  if (!model || !messages) {
    return res.status(400).json({ error: 'Missing model or messages' });
  }

  try {
    const ollamaResponse = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true
      })
    });

    if (!ollamaResponse.ok) {
      const errorText = await ollamaResponse.text();
      return res.status(ollamaResponse.status).json({ 
        error: `Ollama error: ${ollamaResponse.statusText}`, 
        details: errorText 
      });
    }

    // Set appropriate headers for streaming
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Read and pipe the stream to client
    const reader = ollamaResponse.body;
    for await (const chunk of reader) {
      res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error('Proxy chat error:', error);
    return res.status(500).json({ 
      error: 'Failed to connect to local Ollama server.', 
      details: error.message 
    });
  }
});

app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Jellymint Chatbot Server Running on Port ${PORT}`);
  console.log(` Local Ollama Host: ${OLLAMA_HOST}`);
  console.log(` Web UI: http://localhost:${PORT}`);
  console.log(`==================================================`);
});
