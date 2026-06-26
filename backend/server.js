import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import os from 'os';
import { fileURLToPath } from 'url';
import ngrok from '@ngrok/ngrok';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { execSync } from 'child_process';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

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
      `PORT=3000\nOLLAMA_HOST=http://127.0.0.1:11434\nENCRYPTION_KEY=${key}\nGOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json\n`,
      'utf8'
    );
  }
}

dotenv.config();

// Initialize Firebase Admin
try {
  if (getApps().length === 0) {
    initializeApp({
      credential: applicationDefault()
    });
  }
} catch (error) {
  console.error("Failed to initialize Firebase Admin. Ensure GOOGLE_APPLICATION_CREDENTIALS is set in .env and the JSON file exists.");
  console.error(error);
}

const db = getApps().length > 0 ? getFirestore() : null;

const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Auth Middleware
async function verifyToken(req, res, next) {
  if (!db) {
    return res.status(500).json({ error: 'Server misconfiguration: Firebase Admin not initialized.' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split('Bearer ')[1].trim();

  // Support for custom Developer API Keys
  if (token.startsWith('jm_live_')) {
    try {
      const userQuery = await db.collection('users').where('apiKey', '==', token).limit(1).get();
      if (userQuery.empty) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API key.' });
      }
      const userDoc = userQuery.docs[0];
      const userData = userDoc.data();

      // Check if Developer API is suspended globally
      const settingsSnap = await db.collection('settings').doc('global').get();
      if (settingsSnap.exists && settingsSnap.data().suspendDeveloperApi === true) {
        return res.status(403).json({ error: 'Forbidden: Developer API is suspended by the administrator.' });
      }

      // Check if user is banned
      if (userData.banned === true) {
        return res.status(403).json({ error: 'Forbidden: Account is suspended.' });
      }

      // Check if user has PRO or Advanced subscription (Admins are exempt)
      const tier = userData.tier || 'free';
      const emailLower = (userData.email || '').trim().toLowerCase();
      let isAdmin = emailLower === 'aviksamantaofficial@gmail.com';
      if (!isAdmin && emailLower) {
        const adminDoc = await db.collection('admins').doc(emailLower).get();
        if (adminDoc.exists) {
          isAdmin = true;
        }
      }

      if (tier === 'free' && !isAdmin) {
        return res.status(403).json({ error: 'Forbidden: Developer API access requires a PRO or Advanced subscription.' });
      }

      req.user = {
        uid: userDoc.id,
        email: userData.email || '',
        name: userData.name || '',
        isApiKey: true
      };
      return next();
    } catch (error) {
      console.error('API Key verification error:', error);
      return res.status(500).json({ error: 'Internal server error validating API Key.' });
    }
  }

  // Support for standard Firebase JWT ID Tokens
  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

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

function getGpuUsage() {
  try {
    const output = execSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits', { stdio: 'pipe' });
    return parseInt(output.toString().trim()) || 0;
  } catch (e) {
    return 0; // Fallback for environments without Nvidia GPUs
  }
}

function getCpuTemperature(cpuUsage = 0) {
  // 1. Linux
  if (process.platform === 'linux') {
    try {
      if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
        const tempStr = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        const temp = parseFloat(tempStr) / 1000;
        if (temp > 0 && temp < 150) return Math.round(temp);
      }
    } catch (e) {
      // ignore
    }
    // Raspberry Pi vcgencmd check
    try {
      const output = execSync('vcgencmd measure_temp', { stdio: 'pipe' }).toString();
      const match = output.match(/temp=([\d.]+)/);
      if (match) {
        const temp = parseFloat(match[1]);
        if (temp > 0 && temp < 150) return Math.round(temp);
      }
    } catch (e) {
      // ignore
    }
    try {
      if (fs.existsSync('/sys/class/hwmon')) {
        const files = fs.readdirSync('/sys/class/hwmon');
        for (const file of files) {
          const path = `/sys/class/hwmon/${file}/temp1_input`;
          if (fs.existsSync(path)) {
            const tempStr = fs.readFileSync(path, 'utf8');
            const temp = parseFloat(tempStr) / 1000;
            if (temp > 0 && temp < 150) return Math.round(temp);
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 2. Windows
  if (process.platform === 'win32') {
    try {
      const output = execSync('wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature', { stdio: 'pipe' }).toString();
      const lines = output.split('\n').map(line => line.trim()).filter(line => line.length > 0 && !isNaN(line));
      if (lines.length > 0) {
        const rawTemp = parseFloat(lines[0]);
        const temp = (rawTemp / 10) - 273.15;
        if (temp > 0 && temp < 150) return Math.round(temp);
      }
    } catch (e) {
      // ignore
    }
  }

  // 3. macOS (darwin)
  if (process.platform === 'darwin') {
    try {
      const output = execSync('smctemp -c', { stdio: 'pipe' }).toString();
      const temp = parseFloat(output);
      if (temp > 0 && temp < 150) return Math.round(temp);
    } catch (e) {
      // ignore
    }
    try {
      const output = execSync('osx-cpu-temp', { stdio: 'pipe' }).toString();
      const temp = parseFloat(output);
      if (temp > 0 && temp < 150) return Math.round(temp);
    } catch (e) {
      // ignore
    }
  }

  // 4. Fallback (Realistic simulated temperature matching CPU usage load)
  const baseTemp = 42;
  const usageFactor = (cpuUsage / 100) * 35; // rises by up to 35C under load
  const fluctuation = Math.random() * 4 - 2; // +/- 2C jitter
  const calculatedTemp = baseTemp + usageFactor + fluctuation;
  return Math.round(Math.max(35, Math.min(95, calculatedTemp)));
}

app.get('/api/sysinfo', (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const ramPercent = Math.floor((usedMem / totalMem) * 100);
  
  const cpuPercent = getCpuUsage();
  const gpuPercent = getGpuUsage();
  const cpuTemp = getCpuTemperature(cpuPercent);
  
  res.json({ cpu: cpuPercent, ram: ramPercent, gpu: gpuPercent, cpuTemp });
});

// Chatbot Metadata API
app.get('/api/version', (req, res) => {
  res.json({
    name: 'Jellymint',
    version: 'v2.0.0'
  });
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

// Session/IP tracking endpoint
app.post('/api/session', verifyToken, async (req, res) => {
  const uid = req.user.uid;
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (ip && ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }

  try {
    const userRef = db.collection('users').doc(uid);
    await userRef.set({
      ip: ip,
      lastActive: FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[Session] Updated IP to ${ip} for user ${uid}`);
    return res.json({ success: true, ip });
  } catch (err) {
    console.error('[Session] Failed to update session IP:', err);
    return res.status(500).json({ error: 'Failed to update session' });
  }
});

// Proxy route to stream response from local Ollama model
app.post('/api/chat', verifyToken, async (req, res) => {
  const { model, messages } = req.body;
  
  if (!model || !messages) {
    return res.status(400).json({ error: 'Missing model or messages' });
  }

  const uid = req.user.uid;
  const userRef = db.collection('users').doc(uid);
  
  try {
    // 1. Token & Settings Check
    const settingsSnap = await db.collection('settings').doc('global').get();
    const settings = settingsSnap.exists ? settingsSnap.data() : { freeForAll: false, limits: { free: 5000, pro: 50000, advanced: 1000000 } };
    
    // Check for Maintenance Mode (Admins are exempt)
    if (settings.maintenanceMode) {
      const emailLower = (req.user.email || '').trim().toLowerCase();
      let isAdmin = emailLower === 'aviksamantaofficial@gmail.com';
      if (!isAdmin && emailLower) {
        const adminDoc = await db.collection('admins').doc(emailLower).get();
        if (adminDoc.exists) {
          isAdmin = true;
        }
      }

      if (!isAdmin) {
        return res.status(503).json({ 
          error: 'maintenance',
          details: 'Jellymint is currently undergoing system upgrades. We will be back online shortly.' 
        });
      }
    }

    // Check if user is banned
    const userSnap = await userRef.get();
    if (userSnap.exists && userSnap.data().banned === true) {
      return res.status(403).json({
        error: 'banned',
        details: 'Your account has been banned from using the AI service. Please contact support.'
      });
    }

    let userTokens = 0;
    
    if (!settings.freeForAll) {
      let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      if (ip && ip.includes(',')) {
        ip = ip.split(',')[0].trim();
      }
      
      if (!userSnap.exists) {
        // New user — use merge to avoid overwriting frontend-created doc
        userTokens = settings.limits?.free || 5000;
        await userRef.set({ 
          name: req.user.name || req.user.email || '',
          email: req.user.email || '',
          tokens: userTokens, 
          tier: 'free', 
          createdAt: FieldValue.serverTimestamp(),
          lastActive: FieldValue.serverTimestamp(), 
          ip: ip 
        }, { merge: true });
      } else {
        const data = userSnap.data();
        userTokens = data.tokens || 0;
        const tier = data.tier || 'free';
        
        // 24 hour reset logic
        const lastActive = data.lastActive ? data.lastActive.toDate() : new Date(0);
        const now = new Date();
        const hoursSince = (now - lastActive) / (1000 * 60 * 60);
        
        if (hoursSince >= 24) {
           userTokens = settings.limits?.[tier] || 5000;
        }
        
        // Build update payload — fill missing fields, never overwrite existing name/email
        const updatePayload = {
          ip: ip,
          lastActive: FieldValue.serverTimestamp(),
          tokens: userTokens
        };
        if (!data.name && req.user.name) updatePayload.name = req.user.name;
        if (!data.email && req.user.email) updatePayload.email = req.user.email;
        if (!data.tier) updatePayload.tier = 'free';
        
        await userRef.set(updatePayload, { merge: true });
      }
      
      if (userTokens <= 0) {
        return res.status(403).json({ error: 'Token limit exceeded. Wait 24 hours or upgrade tier.' });
      }
    }

    // 2. Call Ollama
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

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 3. Stream to client and track token usage
    const reader = ollamaResponse.body;
    let eval_count = 0;
    let buffer = '';
    
    for await (const chunk of reader) {
      res.write(chunk);
      
      buffer += chunk.toString();
      let boundary = buffer.lastIndexOf('\n');
      if (boundary !== -1) {
        const completeLines = buffer.substring(0, boundary).split('\n');
        buffer = buffer.substring(boundary + 1);
        
        for (const line of completeLines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.eval_count) {
              eval_count += parsed.eval_count;
            }
            if (parsed.prompt_eval_count) {
              eval_count += parsed.prompt_eval_count;
            }
          } catch(e) { }
        }
      }
    }
    
    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer.trim());
        if (parsed.eval_count) {
          eval_count += parsed.eval_count;
        }
        if (parsed.prompt_eval_count) {
          eval_count += parsed.prompt_eval_count;
        }
      } catch(e) { }
    }
    
    res.end();

    // 4. Deduct tokens & Track Daily Usage
    if (eval_count > 0) {
      // Track total daily token usage across all users
      try {
        const todayStr = new Date().toISOString().split('T')[0];
        const usageRef = db.collection('token_usage').doc(todayStr);
        await usageRef.set({
          date: todayStr,
          totalTokensUsed: FieldValue.increment(eval_count)
        }, { merge: true });
        console.log(`[Usage] Logged ${eval_count} tokens to daily usage (${todayStr})`);
      } catch (usageError) {
        console.error('[Usage] Failed to log daily usage:', usageError);
      }

      // Deduct from user account if freeForAll is inactive
      if (!settings.freeForAll) {
        console.log(`[Tokens] Deducting ${eval_count} tokens from user ${uid} (${req.user.email || 'No email'})`);
        await userRef.update({
          tokens: FieldValue.increment(-eval_count)
        });
      } else {
        console.log(`[Tokens] Free-for-all active. Skipped user deduction of ${eval_count} tokens for ${uid}.`);
      }
    }

  } catch (error) {
    console.error('Proxy chat error:', error);
    // If headers not sent yet, return 500
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: 'Failed to process chat request.', 
        details: error.message 
      });
    }
  }
});

app.listen(PORT, async () => {
  console.log(`==================================================`);
  console.log(` Jellymint API Server Running on Port ${PORT}`);
  console.log(` Local Ollama Host: ${OLLAMA_HOST}`);
  
  if (process.env.NGROK_AUTHTOKEN) {
    try {
      console.log(` Starting ngrok tunnel...`);
      const listener = await ngrok.forward({
        addr: PORT,
        authtoken: process.env.NGROK_AUTHTOKEN,
        domain: 'spousal-scrabble-stamina.ngrok-free.dev'
      });
      console.log(` Ngrok tunnel active at: ${listener.url()}`);
      console.log(` Use this URL as VITE_API_URL in your frontend.`);
      
      // Auto-sync the dynamic API URL to Firestore so the Vercel frontend can discover it
      if (db) {
        try {
          await db.collection('settings').doc('global').set({ apiUrl: listener.url() }, { merge: true });
          console.log(` \x1b[32mSynced API URL to Firestore! Frontend will now auto-connect.\x1b[0m`);
        } catch (e) {
          console.error(` \x1b[31mFailed to sync API URL to Firestore. Ensure Firestore Database is created and serviceAccountKey.json is valid.\x1b[0m`);
        }
      }
    } catch (err) {
      console.error(` Ngrok tunnel failed to start:`, err);
      // Fallback: If tunnel is already online or fails, but we have a known static domain,
      // we still ensure Firestore settings have the correct URL so the frontend can connect!
      if (db) {
        try {
          const fallbackUrl = "https://spousal-scrabble-stamina.ngrok-free.dev";
          await db.collection('settings').doc('global').set({ apiUrl: fallbackUrl }, { merge: true });
          console.log(` \x1b[32mFallback: Synced static API URL (${fallbackUrl}) to Firestore!\x1b[0m`);
        } catch (e) {
          console.error(` Failed to sync fallback API URL to Firestore:`, e);
        }
      }
    }
  } else {
    console.log(` NGROK_AUTHTOKEN not found, ngrok tunnel disabled.`);
  }
  
  console.log(`==================================================`);
});
