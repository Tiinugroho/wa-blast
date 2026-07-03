import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import { Client, LocalAuth } from 'whatsapp-web.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup direktori absolut untuk environment ES Modules di Hosting
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sessionDir = path.join(__dirname, 'wa_sessions');

// Pastikan folder wa_sessions ada
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const sessions = {};
const qrData = {};
const userInfo = {};
const killedSessions = {};
const pendingSessions = {};

function normalizeNumber(number) {
    let jid = number.replace(/\D/g, '');
    jid = (jid.startsWith('0') ? '62' + jid.substring(1) : jid) + '@c.us';
    return jid;
}

// ================= START SESSION =================
app.post('/api/wa/start', async (req, res) => {
    const { session_id } = req.body;

    if (!session_id) return res.status(400).json({ error: 'Session ID diperlukan' });

    delete killedSessions[session_id];

    const existingStatus = qrData[session_id]?.status;
    if (pendingSessions[session_id]) {
        return res.json(qrData[session_id] || { status: 'loading', qr: null });
    }

    if (sessions[session_id] && existingStatus === 'connected') {
        return res.json({ status: 'connected', message: 'Session sudah aktif' });
    }

    qrData[session_id] = { status: 'loading', qr: null };

    async function connectToWA() {
        if (killedSessions[session_id]) return;
        if (pendingSessions[session_id] && sessions[session_id]) return;

        pendingSessions[session_id] = true;

        try {
            const sessionPath = path.join(sessionDir, session_id);
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }

            const client = new Client({
                authStrategy: new LocalAuth({ clientId: session_id, dataPath: sessionPath }),
                puppeteer: {
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
                },
                takeoverOnConflict: true,
                restartOnAuthFail: false
            });

            sessions[session_id] = client;

            client.on('qr', async (qr) => {
                qrData[session_id] = {
                    status: 'qr_ready',
                    qr: await qrcode.toDataURL(qr)
                };
            });

            client.on('ready', () => {
                pendingSessions[session_id] = false;
                userInfo[session_id] = {
                    name: client.info?.pushname || 'User Ruang Restu',
                    id: client.info?.wid?._serialized || null
                };
                qrData[session_id] = {
                    status: 'connected',
                    user: userInfo[session_id]
                };
            });

            client.on('auth_failure', (message) => {
                pendingSessions[session_id] = false;
                qrData[session_id] = { status: 'auth_failed', message };
            });

            client.on('disconnected', (reason) => {
                pendingSessions[session_id] = false;
                if (killedSessions[session_id]) {
                    delete sessions[session_id];
                    delete qrData[session_id];
                    delete userInfo[session_id];
                    return;
                }
                qrData[session_id] = { status: 'disconnected', reason };
            });

            await client.initialize();
        } catch (err) {
            delete pendingSessions[session_id];
            console.log(`[WA] CRITICAL ERROR ${session_id}:`, err.message);
            qrData[session_id] = { status: 'disconnected', error: err.message };
        }
    }

    connectToWA();
    res.json({ status: 'initializing' });
});

// ================= LOGOUT TOTAL =================
app.post('/api/wa/logout', async (req, res) => {
    const { session_id } = req.body;
    try {
        console.log(`[WA] LOGOUT REQUEST ${session_id}`);

        killedSessions[session_id] = true;

        const client = sessions[session_id];
        if (client) {
            try {
                await client.destroy();
            } catch (e) { }
        }

        delete sessions[session_id];
        delete qrData[session_id];
        delete userInfo[session_id];
        delete pendingSessions[session_id];

        const sessionPath = path.join(sessionDir, session_id);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }

        res.json({ status: 'logged_out' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= GET STATUS =================
app.get('/api/wa/status/:session_id', (req, res) => {
    res.json(qrData[req.params.session_id] || { status: 'disconnected' });
});

app.get('/', (req, res) => {
    res.json({
        status: "success",
        message: "WA Engine Ruang Restu is running successfully!"
    });
});

// ================= SEND MESSAGE =================
app.post('/api/wa/send', async (req, res) => {
    const { session_id, number, message } = req.body;
    const client = sessions[session_id];
    if (!client) return res.status(401).json({ error: 'Tidak ada sesi' });

    try {
        const jid = normalizeNumber(number);
        await client.sendMessage(jid, message);
        res.json({ status: 'success' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Phusion Passenger di DirectAdmin akan menginjeksi process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`WA Engine Running on Port ${PORT}`);
});