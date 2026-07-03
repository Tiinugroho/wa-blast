import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode';
import {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    initAuthCreds,
    BufferJSON
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
const pendingSessions = {};

function shouldReuseExistingSession(status) {
    return ['loading', 'qr_ready', 'connected'].includes(status);
}

function shouldAutoReconnect(status) {
    return status === 'connected';
}

function normalizeNumber(number) {
    let jid = number.replace(/\D/g, '');
    jid = (jid.startsWith('0') ? '62' + jid.substring(1) : jid) + '@s.whatsapp.net';
    return jid;
}

async function useSmartAuthState(sessionPath) {
    const credsFile = path.join(sessionPath, 'creds.json');
    const keysDir = path.join(sessionPath, 'keys');

    let creds;
    if (fs.existsSync(credsFile)) {
        const raw = fs.readFileSync(credsFile, { encoding: 'utf-8' });
        creds = JSON.parse(raw, BufferJSON.reviver);
    } else {
        creds = initAuthCreds();
    }

    const keys = {};
    if (fs.existsSync(keysDir)) {
        for (const file of fs.readdirSync(keysDir)) {
            if (!file.endsWith('.json')) continue;
            const typeName = file.replace('.json', '');
            const raw = fs.readFileSync(path.join(keysDir, file), { encoding: 'utf-8' });
            const parsed = JSON.parse(raw, BufferJSON.reviver);
            keys[typeName] = parsed;
        }
    }

    let isConnected = false;

    const state = {
        creds,
        keys: {
            get(type, ids) {
                return ids.reduce((dict, id) => {
                    const val = keys[type]?.[id];
                    if (val) dict[id] = val;
                    return dict;
                }, {});
            },
            set(data) {
                for (const category in data) {
                    if (!keys[category]) keys[category] = {};
                    Object.assign(keys[category], data[category]);
                }
                if (isConnected) {
                    flushKeys();
                }
            }
        }
    };

    function flushKeys() {
        if (!fs.existsSync(keysDir)) {
            fs.mkdirSync(keysDir, { recursive: true });
        }
        for (const type in keys) {
            const filePath = path.join(keysDir, `${type}.json`);
            fs.writeFileSync(filePath, JSON.stringify(keys[type], BufferJSON.replacer));
        }
    }

    function saveCreds() {
        if (isConnected) {
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }
            fs.writeFileSync(credsFile, JSON.stringify(creds, BufferJSON.replacer));
        }
    }

    function setConnected(val) {
        isConnected = val;
        if (val) {
            if (!fs.existsSync(sessionPath)) {
                fs.mkdirSync(sessionPath, { recursive: true });
            }
            fs.writeFileSync(credsFile, JSON.stringify(creds, BufferJSON.replacer));
            flushKeys();
        }
    }

    return { state, saveCreds, setConnected };
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

    if (sessions[session_id] && shouldReuseExistingSession(existingStatus)) {
        if (existingStatus === 'connected') {
            return res.json({ status: 'connected', message: 'Session sudah aktif' });
        }
        return res.json(qrData[session_id] || { status: 'loading', qr: null });
    }

    qrData[session_id] = { status: 'loading', qr: null };

    async function connectToWA() {
        if (killedSessions[session_id]) return;
        if (pendingSessions[session_id] && sessions[session_id]) return;

        pendingSessions[session_id] = true;

        try {
            const sessionPath = path.join(sessionDir, session_id);
            const { state, saveCreds, setConnected } = await useSmartAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: ['Ruang Restu', 'Safari', '1.0.0'],
                version,
                syncFullHistory: false
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
                    setConnected(true);

                    userInfo[session_id] = {
                        name: sock.user?.name || 'User Ruang Restu',
                        id: sock.user?.id
                    };
                    qrData[session_id] = {
                        status: 'connected',
                        user: userInfo[session_id]
                    };
                    pendingSessions[session_id] = false;
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const isLoggedOut = [DisconnectReason.loggedOut, 401, 405].includes(statusCode);
                    const currentStatus = qrData[session_id]?.status;
                    const shouldReconnectNow = currentStatus === 'connected' || currentStatus === 'reconnecting';

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
                    } else if (shouldReconnectNow) {
                        qrData[session_id] = {
                            status: 'reconnecting',
                            message: 'Menghubungkan ulang ke WhatsApp...'
                        };
                        setTimeout(() => connectToWA(), 5000);
                    } else {
                        qrData[session_id] = {
                            status: 'connecting',
                            message: 'Menyambungkan ke WhatsApp...'
                        };
                    }
                }
            });
        } catch (err) {
            delete pendingSessions[session_id];
            console.log(`[WA] CRITICAL ERROR ${session_id}:`, err.message);
            if (!qrData[session_id] || qrData[session_id]?.status !== 'connected') {
                if (fs.existsSync(sessionPath) && !fs.existsSync(path.join(sessionPath, 'creds.json'))) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    console.log(`[WA] Folder partial dihapus: ${sessionPath}`);
                }
            }
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
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.json(qrData[req.params.session_id] || { status: 'disconnected' });
});

app.get('/', (req, res) => {
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({
        status: 'success',
        message: 'WA Engine Ruang Restu is running successfully!'
    });
});

// ================= SEND MESSAGE =================
app.post('/api/wa/send', async (req, res) => {
    const { session_id, number, message } = req.body;
    const sock = sessions[session_id];
    if (!sock) return res.status(401).json({ error: 'Tidak ada sesi' });

    try {
        const jid = normalizeNumber(number);
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