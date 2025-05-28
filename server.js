const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const Pino = require('pino');
const { default: ToxxicTechConnect, useMultiFileAuthState, DisconnectReason, makeInMemoryStore, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { HttpsProxyAgent } = require('https-proxy-agent');
const userAgent = require('user-agents');
const crypto = require('crypto'); // Added missing import

const app = express();
const PORT = process.env.PORT || 3000;

// Proxy configuration
const PROXY_URL = process.env.PROXY_URL || 'https://my-generic-api.com'; // Set your proxy URL here

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Enhanced logger with minimal output
const log = (message) => {
    console.log(`\x1b[36m[${new Date().toISOString()}]\x1b[0m \x1b[32m[LEVI-MD]\x1b[0m → ${message}`);
};
const errorLog = (message) => {
    console.error(`\x1b[36m[${new Date().toISOString()}]\x1b[0m \x1b[31m[LEVI-MD]\x1b[0m → ❌ ${message}`);
};

// Session storage
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    log(`Created sessions directory.`);
}

// Store active connections and reconnection attempts
const activeConnections = new Map();
const reconnectionAttempts = new Map();
const store = makeInMemoryStore({
    logger: Pino().child({ level: 'silent', stream: 'store' }),
});

// Generate random session ID
function generateSessionId() {
    const prefix = 'levi';
    const randomChars = crypto.randomBytes(4).toString('hex'); // Use crypto for randomness
    return `${prefix}${Math.floor(Math.random() * 1000000)}${randomChars}`.toLowerCase();
}

// Create zip from session folder
function createZip(sessionId, res) {
    const sessionPath = path.join(sessionsDir, sessionId);
    const zipPath = path.join(sessionsDir, `${sessionId}.zip`);
    
    if (!fs.existsSync(sessionPath)) {
        return res.status(404).send('Session not found');
    }

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => {
        res.download(zipPath, `${sessionId}.zip`, (err) => {
            if (err) errorLog(`Download error: ${err.message}`);
            fs.unlinkSync(zipPath);
        });
    });
    
    archive.on('error', (err) => {
        errorLog(`Archive error: ${err.message}`);
        res.status(500).send('Error creating zip file');
    });
    
    archive.pipe(output);
    archive.directory(sessionPath, false);
    archive.finalize();
}

// Randomize browser identifiers
function getRandomBrowser() {
    const browsers = [
        ['Firefox', 'Mozilla', '91.0'],
        ['Chrome', 'Chromium', '103.0'],
        ['Safari', 'WebKit', '15.0'],
        ['Edge', 'Edg', '99.0']
    ];
    const platforms = ['Windows NT 10.0', 'Macintosh; Intel Mac OS X 10_15_7', 'X11; Linux x86_64'];
    const [browser, engine, version] = browsers[Math.floor(Math.random() * browsers.length)];
    const platform = platforms[Math.floor(Math.random() * platforms.length)];
    return [platform, browser, version];
}

// Throttle function to add delay
async function throttleRequest() {
    const delay = Math.random() * 1000 + 500; // 500-1500ms
    await new Promise(resolve => setTimeout(resolve, delay));
}

// Initialize WhatsApp connection with proxy
async function createWhatsAppConnection(sessionId, number) {
    const sessionPath = path.join(sessionsDir, sessionId);
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    // Configure proxy agent
    let proxyAgent;
    try {
        proxyAgent = new HttpsProxyAgent(PROXY_URL);
    } catch (err) {
        errorLog(`Proxy agent error: ${err.message}`);
        throw err;
    }
    
    const sock = ToxxicTechConnect({
        logger: Pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 15000,
        emitOwnEvents: true,
        fireInitQueries: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        browser: getRandomBrowser(),
        fetchAgent: proxyAgent,
        userAgent: new userAgent().toString(),
        getMessage: async () => ({}),
    });

    store.bind(sock.ev);
    
    sock.ev.on('creds.update', saveCreds);

    let messageSent = false;
    const maxReconnects = 3;
    if (!reconnectionAttempts.has(sessionId)) {
        reconnectionAttempts.set(sessionId, 0);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const attempts = reconnectionAttempts.get(sessionId) || 0;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
            
            if (statusCode !== DisconnectReason.loggedOut && !messageSent && attempts < maxReconnects) {
                reconnectionAttempts.set(sessionId, attempts + 1);
                errorLog(`Connection closed for ${sessionId}. Attempt ${attempts + 1}/${maxReconnects}. Status: ${statusCode}, Error: ${errorMessage}`);
                await throttleRequest();
                setTimeout(() => createWhatsAppConnection(sessionId, number), 2000 + Math.random() * 1000);
            } else {
                errorLog(`Max reconnects reached or message sent for ${sessionId}. Status: ${statusCode}, Error: ${errorMessage}`);
                activeConnections.delete(sessionId);
                reconnectionAttempts.delete(sessionId);
            }
        } else if (connection === 'open' && !messageSent) {
            log(`Successfully connected ${sessionId}`);
            messageSent = true;
            
            try {
                const cleanNumber = number.replace(/[^\d]/g, '');
                const normalizedJid = jidNormalizedUser(cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`);
                
                if (normalizedJid) {
                    await throttleRequest();
                    const beautifulMessage = {
                        text: `✨ *LEVI MD CONNECTION SUCCESSFUL* ✨\n\n` +
                              `✅ Your session is now ready to use!\n\n` +
                              `🔑 *Session ID:* ${sessionId.toUpperCase()}\n` +
                              `📅 *Created at:* ${new Date().toLocaleString()}\n\n` +
                              `_Deploy Guide https://github.com/ReirLair/Levi-Md_`,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true
                        }
                    };
                    
                    await sock.sendMessage(normalizedJid, beautifulMessage);
                    log(`Successfully sent confirmation to ${normalizedJid}`);
                }
            } catch (err) {
                errorLog(`Error sending confirmation: ${err.message}`);
            } finally {
                log(`Closing connection for ${sessionId} after confirmation`);
                try {
                    if (sock.ws && sock.ws.readyState === sock.ws.OPEN) {
                        sock.ws.close();
                        log(`WebSocket closed for ${sessionId}`);
                    }
                } catch (e) {
                    errorLog(`Error closing WebSocket: ${e.message}`);
                }
                activeConnections.delete(sessionId);
                reconnectionAttempts.delete(sessionId);
            }
        }
    });

    return sock;
}

// Pairing endpoint
app.post('/pair', async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Phone number required' });

    const sessionId = generateSessionId();
    
    try {
        await throttleRequest();
        const sock = await createWhatsAppConnection(sessionId, number);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const cleanNumber = number.replace(/[^\d]/g, '');
        const code = await sock.requestPairingCode(cleanNumber);
        if (!code) throw new Error('Failed to get pairing code');
        
        const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
        
        activeConnections.set(sessionId, { 
            sock, 
            number: cleanNumber,
            createdAt: Date.now() 
        });

        setTimeout(() => {
            if (activeConnections.has(sessionId)) {
                log(`Cleaning up stalled connection for ${sessionId}`);
                try {
                    activeConnections.get(sessionId)?.sock?.ws?.close();
                } catch (err) {
                    errorLog(`Cleanup error: ${err.message}`);
                }
                activeConnections.delete(sessionId);
                reconnectionAttempts.delete(sessionId);
            }
        }, 300000);

        res.json({ 
            sessionId,
            code: formattedCode,
            message: 'Check your WhatsApp for connection confirmation'
        });
        
    } catch (error) {
        errorLog(`Pairing error: ${error.message}`);
        
        try {
            activeConnections.get(sessionId)?.sock?.ws?.close();
            activeConnections.delete(sessionId);
            reconnectionAttempts.delete(sessionId);
        } catch (err) {
            errorLog(`Cleanup error: ${err.message}`);
        }
        
        res.status(500).json({ error: error.message });
    }
});

// Download endpoint
app.get('/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    createZip(sessionId, res);
});

// Cleanup interval for stale connections
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, conn] of activeConnections) {
        if (now - conn.createdAt > 3600000) {
            log(`Cleaning up stale connection for ${sessionId}`);
            try {
                conn.sock?.ws?.close();
            } catch (err) {
                errorLog(`Cleanup error: ${err.message}`);
            }
            activeConnections.delete(sessionId);
            reconnectionAttempts.delete(sessionId);
        }
    }
}, 60000);

// Start server
app.listen(PORT, () => {
    log(`Server running on http://localhost:${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    log('Shutting down server...');
    for (const [sessionId, conn] of activeConnections) {
        try {
            conn.sock?.ws?.close();
        } catch (err) {
            errorLog(`Error closing WebSocket for ${sessionId}: ${err.message}`);
        }
        activeConnections.delete(sessionId);
        reconnectionAttempts.delete(sessionId);
    }
    process.exit(0);
});
