import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import {
    makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
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

// ================= START SESSION =================
app.post('/api/wa/start', async (req, res) => {
    const { session_id } = req.body;

    if (!session_id) return res.status(400).json({ error: 'Session ID diperlukan' });

    delete killedSessions[session_id];

    if (sessions[session_id] && qrData[session_id]?.status === 'connected') {
        return res.json({ status: 'connected', message: 'Session sudah aktif' });
    }

    qrData[session_id] = { status: 'loading', qr: null };

    async function connectToWA() {
        if (killedSessions[session_id]) return;

        try {
            const sessionPath = path.join(sessionDir, session_id);
            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: ["Ruang Restu", "Safari", "1.0.0"],
                version
            });

            sessions[session_id] = sock;
            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    qrData[session_id] = {
                        status: 'qr_ready',
                        qr: await qrcode.toDataURL(qr)
                    };
                }

                if (connection === 'open') {
                    console.log(`[WA] ${session_id} CONNECTED ✅`);
                    userInfo[session_id] = {
                        name: sock.user?.name || 'User Ruang Restu',
                        id: sock.user?.id
                    };
                    qrData[session_id] = {
                        status: 'connected',
                        user: userInfo[session_id]
                    };
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const isLoggedOut = [DisconnectReason.loggedOut, 401, 405].includes(statusCode);

                    console.log(`[WA] ${session_id} CLOSED. Code: ${statusCode}`);

                    if (isLoggedOut || killedSessions[session_id]) {
                        delete sessions[session_id];
                        delete qrData[session_id];

                        if (fs.existsSync(sessionPath)) {
                            fs.rmSync(sessionPath, { recursive: true, force: true });
                        }

                        if (!killedSessions[session_id]) {
                            setTimeout(() => connectToWA(), 3000);
                        }
                    } else {
                        setTimeout(() => connectToWA(), 5000);
                    }
                }
            });
        } catch (err) {
            console.log(`[WA] CRITICAL ERROR ${session_id}:`, err.message);
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

        const sock = sessions[session_id];
        if (sock) {
            try {
                await sock.logout();
                sock.ws.close();
            } catch (e) { }
        }

        delete sessions[session_id];
        delete qrData[session_id];

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

// ================= SEND MESSAGE =================
app.post('/api/wa/send', async (req, res) => {
    const { session_id, number, message } = req.body;
    const sock = sessions[session_id];
    if (!sock) return res.status(401).json({ error: 'Tidak ada sesi' });

    try {
        let jid = number.replace(/\D/g, '');
        jid = (jid.startsWith('0') ? '62' + jid.substring(1) : jid) + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
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