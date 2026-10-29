const http = require('http');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { Pool } = require('pg');

// Inicializar Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
    credential: cert(serviceAccount)
});

// Conexión oficial a PostgreSQL
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'chikichat_db',
    password: '', // Déjala vacía si no configuraste contraseña en postgres
    port: 5432,
});

pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Error al conectar a PostgreSQL:', err);
    } else {
        console.log('Conectado exitosamente a PostgreSQL:', res.rows[0].now);
    }
});

const DB_USERS = path.join(__dirname, 'usuarios.json');
const DB_MESSAGES = path.join(__dirname, 'mensajes.json');
const DB_RELATIONS = path.join(__dirname, 'relaciones.json');
const DB_PUBLICATIONS = path.join(__dirname, 'publicaciones.json');

// Asegurar que las carpetas de almacenamiento existan físicamente
const uploadDir = path.join(__dirname, 'uploads');
const avatarsDir = path.join(__dirname, 'uploads', 'avatars');
const publicationDir = path.join(__dirname, 'uploads', 'publication');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
}
if (!fs.existsSync(publicationDir)) {
    fs.mkdirSync(publicationDir, { recursive: true });
}

// Configuración de Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (req.url.startsWith('/upload_avatar') || file.fieldname === 'avatar') {
            cb(null, avatarsDir);
        } else if (req.url.startsWith('/upload_publication')) {
            cb(null, publicationDir);
        } else {
            cb(null, uploadDir);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Solo se permiten archivos de imagen o video válidos.'), false);
        }
    }
});

function leerJson(filePath) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify([]));
    }
    const data = fs.readFileSync(filePath, 'utf8');
    try {
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

function guardarJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const server = http.createServer((req, res) => {

    // 1. RUTA PARA SERVIR ARCHIVOS ESTÁTICOS
    if (req.url.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, req.url);
        
        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Archivo no encontrado');
            return;
        }

        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const range = req.headers.range;

        let ext = path.extname(filePath).toLowerCase();
        let contentType = 'application/octet-stream';
        
        if (ext === '.mp4' || ext === '.m4v') contentType = 'video/mp4';
        else if (ext === '.mkv') contentType = 'video/x-matroska';
        else if (ext === '.mov') contentType = 'video/quicktime';
        else if (ext === '.webm') contentType = 'video/webm';
        else if (ext === '.gif') contentType = 'image/gif';
        else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
        else if (ext === '.png') contentType = 'image/png';
        else if (ext === '.webp') contentType = 'image/webp';
        else if (ext === '.heic') contentType = 'image/heic';

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            
            if (start >= fileSize) {
                res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
                res.end();
                return;
            }

            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': contentType,
            };

            res.writeHead(206, head);
            file.pipe(res);
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': contentType,
            };
            res.writeHead(200, head);
            fs.createReadStream(filePath).pipe(res);
        }
        return;
    }

    // 2. RUTA PARA SUBIR FOTO DE PERFIL
    if (req.method === 'POST' && (req.url === '/upload_avatar' || req.url === '/upload_avatar/')) {
        upload.single('avatar')(req, res, async (err) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
                return;
            }

            if (!req.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'No se subió ninguna imagen de perfil' }));
                return;
            }

            const username = req.body.username;
            if (!username) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'Falta el nombre de usuario' }));
                return;
            }

            const avatarUrl = `/uploads/avatars/${req.file.filename}`;
            try {
                await pool.query('UPDATE users SET avatar_url = $1 WHERE username = $2', [avatarUrl, username]);
                console.log(`[PERFIL PG] Foto actualizada para: ${username} -> ${avatarUrl}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'SUCCESS',
                    avatarUrl: avatarUrl,
                    message: 'Foto de perfil actualizada con éxito'
                }));
            } catch (dbErr) {
                console.error('[DB ERROR AVATAR]:', dbErr);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'Error interno al actualizar avatar' }));
            }
        });
        return;
    }

    // 3. RUTA PARA SUBIR PUBLICACIONES EN EL FEED
    if (req.method === 'POST' && (req.url === '/upload_publication' || req.url === '/upload_publication/')) {
        upload.single('media')(req, res, (err) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
                return;
            }

            if (!req.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'No se subió ningún archivo multimedia' }));
                return;
            }

            const { username, caption } = req.body;
            if (!username) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'Falta el nombre de usuario' }));
                return;
            }

            const mediaUrl = `/uploads/publication/${req.file.filename}`;
            let publicaciones = leerJson(DB_PUBLICATIONS);

            const nuevaPublicacion = {
                id: Date.now().toString() + '-' + Math.round(Math.random() * 1E6),
                username: username,
                caption: caption || '',
                mediaUrl: mediaUrl,
                timestamp: Date.now(),
                likes: []
            };

            publicaciones.push(nuevaPublicacion);
            guardarJson(DB_PUBLICATIONS, publicaciones);

            console.log(`[PUBLICACION] Creada por ${username} -> ${mediaUrl}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'SUCCESS',
                mediaUrl: mediaUrl,
                message: 'Publicación creada con éxito'
            }));
        });
        return;
    }

    // 4. RUTA PARA SUBIR ARCHIVOS MULTIMEDIA EN CHAT
    if (req.method === 'POST' && (req.url === '/upload' || req.url === '/upload/')) {
        upload.single('media')(req, res, async (err) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: err.message }));
                return;
            }

            if (!req.file) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'No se subió ningún archivo' }));
                return;
            }

            const { sender, receiver, message, type, replyToText, replyToSender } = req.body;
            const mediaUrl = `/uploads/${req.file.filename}`;
            const tipoMensaje = type || (req.file.mimetype.startsWith('video') ? 'video' : 'gif');

            let mensajes = leerJson(DB_MESSAGES);
            const nuevoMensaje = {
                sender,
                receiver,
                message: message || '',
                type: tipoMensaje,
                mediaUrl,
                replyToText: replyToText || '',
                replyToSender: replyToSender || '',
                timestamp: Date.now(),
                read: false
            };
            mensajes.push(nuevoMensaje);
            guardarJson(DB_MESSAGES, mensajes);

            try {
                const userQuery = await pool.query('SELECT fcm_token FROM users WHERE username = $1', [receiver]);
                if (userQuery.rows.length > 0 && userQuery.rows[0].fcm_token) {
                    const targetToken = userQuery.rows[0].fcm_token;
                    const payload = {
                        token: targetToken,
                        data: {
                            sender: sender,
                            message: tipoMensaje === 'video' ? '[Video]' : '[GIF]'
                        },
                        notification: {
                            title: sender,
                            body: tipoMensaje === 'video' ? 'Te ha enviado un video' : 'Te ha enviado un GIF'
                        },
                        android: {
                            priority: 'high',
                            notification: {
                                channelId: 'chikichat_channel',
                                sound: 'default',
                                clickAction: 'OPEN_CHAT'
                            }
                        }
                    };

                    getMessaging().send(payload)
                        .then(response => console.log(`[PUSH NOTIFICATION] Multimedia enviada a ${receiver}:`, response))
                        .catch(error => console.log(`[PUSH ERROR] Falló notificación multimedia a ${receiver}:`, error));
                }
            } catch (e) {
                console.error('[PUSH ERROR DB]:', e);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'SUCCESS',
                mediaUrl: mediaUrl,
                fileType: tipoMensaje
            }));
        });
        return;
    }

    // 5. RUTAS GENERALES DE CHIKICHAT (POST /login con PostgreSQL integrado)
    if (req.method === 'POST' && (req.url === '/login' || req.url === '/login/')) {
        let body = "";
        
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const { 
                    username, password, action, searchTarget, sender, receiver, 
                    message, targetUser, response, decision, fcmToken, 
                    newUsername, newPassword, replyToText, replyToSender, 
                    age, gender, postId 
                } = data;
                
                res.writeHead(200, { 'Content-Type': 'application/json' });

                if (action === 'register') {
                    let numericAge = parseInt(age);
                    if (isNaN(numericAge) && typeof age === 'string') {
                        const match = age.match(/\d+/);
                        if (match) numericAge = parseInt(match[0]);
                    }

                    // Validación de edad corregida: Acepta de 10 a 99 años
                    if (isNaN(numericAge) || numericAge < 10 || numericAge > 99) {
                        res.end(JSON.stringify({ status: 'ERROR', message: 'La edad debe estar comprendida entre 10 y 99 años' }));
                        return;
                    }

                    // Verificar en PostgreSQL si el usuario ya existe
                    const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
                    if (userCheck.rows.length > 0) {
                        res.end(JSON.stringify({ status: 'ERROR', message: 'El usuario ya existe' }));
                        return;
                    }

                    // Insertar usuario en PostgreSQL
                    await pool.query(
                        'INSERT INTO users (username, password, age, gender, avatar_url, fcm_token) VALUES ($1, $2, $3, $4, $5, $6)',
                        [username, password, numericAge, gender || 'No especificado', null, null]
                    );

                    console.log(`[REGISTRO PG] Usuario creado: ${username} (Edad: ${numericAge})`);
                    res.end(JSON.stringify({ status: 'SUCCESS', message: 'Cuenta creada' }));

                } else if (action === 'login') {
                    // Buscar usuario en PostgreSQL
                    const userResult = await pool.query('SELECT * FROM users WHERE username = $1', [username]);

                    if (userResult.rows.length === 0) {
                        res.end(JSON.stringify({ status: 'USER_NOT_FOUND', message: 'Usuario no existe' }));
                    } else {
                        const dbUser = userResult.rows[0];
                        if (dbUser.password !== password) {
                            res.end(JSON.stringify({ status: 'WRONG_PASSWORD', message: 'Contraseña incorrecta' }));
                        } else {
                            console.log(`[LOGIN PG] Bienvenido: ${username}`);
                            res.end(JSON.stringify({ 
                                status: 'SUCCESS', 
                                message: 'Bienvenido',
                                avatarUrl: dbUser.avatar_url || null
                            }));
                        }
                    }
                } else if (action === 'update_token') {
                    if (fcmToken && username) {
                        await pool.query('UPDATE users SET fcm_token = $1 WHERE username = $2', [fcmToken, username]);
                        console.log(`[FCM TOKEN PG] Actualizado para: ${username}`);
                    }
                    res.end(JSON.stringify({ status: 'SUCCESS', message: 'Token actualizado' }));
                } else {
                    // Para mantener el funcionamiento operativo actual de las otras acciones por JSON mientras se migran por completo
                    let usuarios = leerJson(DB_USERS);
                    let usuarioEncontrado = usuarios.find(u => u.username === username);
                    let relaciones = leerJson(DB_RELATIONS);
                    let mensajes = leerJson(DB_MESSAGES);

                    if (action === 'get_community_users') {
                        let otherUsers = usuarios.filter(u => u.username.toLowerCase() !== (username || '').toLowerCase());
                        let usersWithStatus = otherUsers.map(otherUserObj => {
                            let otherUser = otherUserObj.username;
                            let rel = relaciones.find(r => 
                                (r.user1 === username && r.user2 === otherUser) || 
                                (r.user1 === otherUser && r.user2 === username)
                            );
                            let status = 'none';
                            if (rel) {
                                if (rel.status === 'friends') status = 'friends';
                                else if (rel.status === 'pending') status = (rel.sender === username) ? 'pending_sent' : 'pending_received';
                            }
                            return { username: otherUser, relationStatus: status, avatarUrl: otherUserObj.avatarUrl || null };
                        });
                        res.end(JSON.stringify({ status: 'SUCCESS', users: usersWithStatus }));
                    } else if (action === 'search') {
                        const query = (searchTarget || '').toLowerCase().trim();
                        if (!query) {
                            res.end(JSON.stringify({ status: 'SUCCESS', users: [] }));
                            return;
                        }
                        let matches = usuarios.filter(u => u.username.toLowerCase().includes(query) && u.username.toLowerCase() !== (username || '').toLowerCase());
                        let usersWithStatus = matches.map(otherUserObj => {
                            let otherUser = otherUserObj.username;
                            let rel = relaciones.find(r => 
                                (r.user1 === username && r.user2 === otherUser) || 
                                (r.user1 === otherUser && r.user2 === username)
                            );
                            let status = 'none';
                            if (rel) {
                                if (rel.status === 'friends') status = 'friends';
                                else if (rel.status === 'pending') status = (rel.sender === username) ? 'pending_sent' : 'pending_received';
                            }
                            return { username: otherUser, relationStatus: status, avatarUrl: otherUserObj.avatarUrl || null };
                        });
                        res.end(JSON.stringify({ status: 'SUCCESS', users: usersWithStatus }));
                    } else if (action === 'send_request') {
                        let relExistente = relaciones.find(r => 
                            (r.user1 === username && r.user2 === targetUser) || 
                            (r.user1 === targetUser && r.user2 === username)
                        );
                        if (!relExistente) {
                            relaciones.push({ user1: username, user2: targetUser, sender: username, status: 'pending' });
                            guardarJson(DB_RELATIONS, relaciones);
                        }
                        res.end(JSON.stringify({ status: 'SUCCESS', message: 'Solicitud enviada' }));
                    } else if (action === 'get_pending_requests') {
                        let pending = [];
                        relaciones.forEach(r => {
                            if (r.status === 'pending') {
                                if (r.user1 === username && r.sender !== username) pending.push(r.user2);
                                if (r.user2 === username && r.sender !== username) pending.push(r.user1);
                            }
                        });
                        res.end(JSON.stringify({ status: 'SUCCESS', requests: pending }));
                    } else if (action === 'respond_request') {
                        let target = targetUser || sender;
                        let dec = decision || response;
                        let index = relaciones.findIndex(r => 
                            (r.user1 === username && r.user2 === target) || 
                            (r.user1 === target && r.user2 === username) ||
                            (r.user1 === sender && r.user2 === receiver) ||
                            (r.user1 === receiver && r.user2 === sender)
                        );
                        if (index !== -1) {
                            if (dec === 'accept') relaciones[index].status = 'friends';
                            else relaciones.splice(index, 1);
                            guardarJson(DB_RELATIONS, relaciones);
                        }
                        res.end(JSON.stringify({ status: 'SUCCESS', message: 'Respuesta procesada' }));
                    } else if (action === 'send_message') {
                        const tipoMensaje = data.type || 'text';
                        mensajes.push({ sender, receiver, message, type: tipoMensaje, replyToText: replyToText || '', replyToSender: replyToSender || '', timestamp: Date.now(), read: false });
                        guardarJson(DB_MESSAGES, mensajes);
                        res.end(JSON.stringify({ status: 'SUCCESS', message: 'Mensaje enviado' }));
                    } else if (action === 'get_messages') {
                        let chatMessages = mensajes.filter(m => (m.sender === sender && m.receiver === receiver) || (m.sender === receiver && m.receiver === sender));
                        res.end(JSON.stringify({ status: 'SUCCESS', messages: chatMessages }));
                    } else if (action === 'mark_as_read') {
                        let modificado = false;
                        mensajes.forEach(m => {
                            if (m.sender === sender && m.receiver === receiver && !m.read) {
                                m.read = true;
                                modificado = true;
                            }
                        });
                        if (modificado) guardarJson(DB_MESSAGES, mensajes);
                        res.end(JSON.stringify({ status: 'SUCCESS', message: 'Leído' }));
                    } else if (action === 'get_conversations') {
                        let amigosValidos = new Set();
                        relaciones.forEach(r => {
                            if (r.status === 'friends') {
                                if (r.user1 === username) amigosValidos.add(r.user2);
                                if (r.user2 === username) amigosValidos.add(r.user1);
                            }
                        });
                        let userChats = {};
                        amigosValidos.forEach(amigo => {
                            let friendObj = usuarios.find(u => u.username === amigo);
                            userChats[amigo] = { withUser: amigo, lastMessage: "Toca para iniciar conversación", timestamp: 0, hasUnread: false, avatarUrl: friendObj ? friendObj.avatarUrl : null };
                        });
                        mensajes.forEach(m => {
                            if (m.sender === username || m.receiver === username) {
                                let otherUser = (m.sender === username) ? m.receiver : m.sender;
                                if (amigosValidos.has(otherUser)) {
                                    let previewText = m.type === 'text' ? m.message : (m.type === 'video' ? '[Video]' : '[GIF]');
                                    let friendObj = usuarios.find(u => u.username === otherUser);
                                    if (m.timestamp > userChats[otherUser].timestamp) {
                                        let unread = (m.receiver === username && !m.read);
                                        userChats[otherUser] = { withUser: otherUser, lastMessage: previewText, timestamp: m.timestamp, hasUnread: unread, avatarUrl: friendObj ? friendObj.avatarUrl : null };
                                    } else {
                                        if (m.receiver === username && !m.read) userChats[otherUser].hasUnread = true;
                                    }
                                }
                            }
                        });
                        let conversations = Object.values(userChats).sort((a, b) => b.timestamp - a.timestamp);
                        res.end(JSON.stringify({ status: 'SUCCESS', conversations: conversations }));
                    } else {
                        res.end(JSON.stringify({ status: 'ERROR', message: 'Acción no válida o no soportada' }));
                    }
                }
            } catch (dbErr) {
                console.error('[ERROR GENERAL EN /login]:', dbErr);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'Error interno en el servidor' }));
            }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Ruta no encontrada');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT} con PostgreSQL conectado.`);
});
