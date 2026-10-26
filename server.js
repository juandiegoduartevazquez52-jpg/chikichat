const http = require('http');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

// Inicializar Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
    credential: cert(serviceAccount)
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

// Configuración de Multer con destino dinámico (Avatares, Chats y Publicaciones)
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
    limits: { fileSize: 50 * 1024 * 1024 }, // Ampliado a 50 MB
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

    // 1. RUTA PARA SERVIR ARCHIVOS ESTÁTICOS CON STREAMING Y SOPORTE DE CABECERAS RANGE
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

    // 2. RUTA PARA SUBIR FOTO DE PERFIL (POST /upload_avatar) - Tolerante a variaciones de URL
    if (req.method === 'POST' && (req.url === '/upload_avatar' || req.url === '/upload_avatar/')) {
        upload.single('avatar')(req, res, (err) => {
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

            let usuarios = leerJson(DB_USERS);
            let userIndex = usuarios.findIndex(u => u.username === username);

            if (userIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'Usuario no encontrado' }));
                return;
            }

            const avatarUrl = `/uploads/avatars/${req.file.filename}`;
            usuarios[userIndex].avatarUrl = avatarUrl;
            guardarJson(DB_USERS, usuarios);

            console.log(`[PERFIL] Foto de perfil actualizada para: ${username} -> ${avatarUrl}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'SUCCESS',
                avatarUrl: avatarUrl,
                message: 'Foto de perfil actualizada con éxito'
            }));
        });
        return;
    }

    // 3. RUTA PARA SUBIR PUBLICACIONES EN EL FEED (POST /upload_publication)
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

    // 4. RUTA PARA SUBIR ARCHIVOS MULTIMEDIA EN CHAT (POST /upload)
    if (req.method === 'POST' && (req.url === '/upload' || req.url === '/upload/')) {
        upload.single('media')(req, res, (err) => {
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

            let usuarios = leerJson(DB_USERS);
            let targetUserObj = usuarios.find(u => u.username === receiver);
            if (targetUserObj && targetUserObj.fcmToken) {
                const payload = {
                    token: targetUserObj.fcmToken,
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'SUCCESS',
                mediaUrl: mediaUrl,
                fileType: tipoMensaje
            }));
        });
        return;
    }

    // 5. RUTAS GENERALES DE CHIKICHAT (POST /login)
    if (req.method === 'POST' && (req.url === '/login' || req.url === '/login/')) {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { 
                    username, password, action, searchTarget, sender, receiver, 
                    message, targetUser, response, decision, fcmToken, 
                    newUsername, newPassword, replyToText, replyToSender, 
                    age, gender, postId 
                } = data;
                
                let usuarios = leerJson(DB_USERS);
                let usuarioEncontrado = usuarios.find(u => u.username === username);

                res.writeHead(200, { 'Content-Type': 'application/json' });

                if (action === 'register') {
                    if (usuarioEncontrado) {
                        res.end(JSON.stringify({ status: 'ERROR', message: 'El usuario ya existe' }));
                    } else {
                        let numericAge = parseInt(age);
                        if (isNaN(numericAge) && typeof age === 'string') {
                            const match = age.match(/\d+/);
                            if (match) numericAge = parseInt(match[0]);
                        }

                        if (isNaN(numericAge) || numericAge < 13 || numericAge > 19) {
                            res.end(JSON.stringify({ status: 'ERROR', message: 'La edad debe estar comprendida estrictamente entre 13 y 19 años' }));
                            return;
                        }

                        usuarios.push({ 
                            username, 
                            password, 
                            age: age, 
                            gender: gender || 'No especificado', 
                            fcmToken: null, 
                            avatarUrl: null 
                        });
                        guardarJson(DB_USERS, usuarios);
                        console.log(`[REGISTRO] Usuario creado: ${username}`);
                        res.end(JSON.stringify({ status: 'SUCCESS', message: 'Cuenta creada' }));
                    }
                } else if (action === 'login') {
                    if (!usuarioEncontrado) {
                        res.end(JSON.stringify({ status: 'USER_NOT_FOUND', message: 'Usuario no existe' }));
                    } else if (usuarioEncontrado.password !== password) {
                        res.end(JSON.stringify({ status: 'WRONG_PASSWORD', message: 'Contraseña incorrecta' }));
                    } else {
                        console.log(`[LOGIN] Bienvenido: ${username}`);
                        res.end(JSON.stringify({ 
                            status: 'SUCCESS', 
                            message: 'Bienvenido',
                            avatarUrl: usuarioEncontrado.avatarUrl || null
                        }));
                    }
                } else if (action === 'update_token') {
                    let index = usuarios.findIndex(u => u.username === username);
                    if (index !== -1) {
                        usuarios[index].fcmToken = fcmToken;
                        guardarJson(DB_USERS, usuarios);
                        console.log(`[FCM TOKEN] Actualizado para: ${username}`);
                    }
                    res.end(JSON.stringify({ status: 'SUCCESS', message: 'Token actualizado' }));
                } else if (action === 'update_profile') {
                    let relaciones = leerJson(DB_RELATIONS);
                    let mensajes = leerJson(DB_MESSAGES);

                    let userIndex = usuarios.findIndex(u => u.username === username);
                    if (userIndex === -1) {
                        res.end(JSON.stringify({ status: 'ERROR', message: 'Usuario no encontrado' }));
                        return;
                    }

                    if (newUsername && newUsername !== username) {
                        let existe = usuarios.some(u => u.username.toLowerCase() === newUsername.toLowerCase());
                        if (existe) {
                            res.end(JSON.stringify({ status: 'ERROR', message: 'El nombre de usuario ya existe' }));
                            return;
                        }

                        relaciones.forEach(r => {
                            if (r.user1 === username) r.user1 = newUsername;
                            if (r.user2 === username) r.user2 = newUsername;
                            if (r.sender === username) r.sender = newUsername;
                        });
                        guardarJson(DB_RELATIONS, relaciones);

                        mensajes.forEach(m => {
                            if (m.sender === username) m.sender = newUsername;
                            if (m.receiver === username) m.receiver = newUsername;
                        });
                        guardarJson(DB_MESSAGES, mensajes);

                        usuarios[userIndex].username = newUsername;
                    }

                    if (newPassword && newPassword.trim() !== '') {
                        usuarios[userIndex].password = newPassword;
                    }

                    guardarJson(DB_USERS, usuarios);
                    console.log(`[PERFIL] Perfil actualizado para: ${username} -> ${newUsername || username}`);
                    res.end(JSON.stringify({ status: 'SUCCESS', message: 'Perfil actualizado con éxito' }));
                } else if (action === 'get_community_users') {
                    let relaciones = leerJson(DB_RELATIONS);
                    let otherUsers = usuarios.filter(u => u.username.toLowerCase() !== (username || '').toLowerCase());

                    let usersWithStatus = otherUsers.map(otherUserObj => {
                        let otherUser = otherUserObj.username;
                        let rel = relaciones.find(r => 
                            (r.user1 === username && r.user2 === otherUser) || 
                            (r.user1 === otherUser && r.user2 === username)
                        );

                        let status = 'none';
                        if (rel) {
                            if (rel.status === 'friends') {
                                status = 'friends';
                            } else if (rel.status === 'pending') {
                                status = (rel.sender === username) ? 'pending_sent' : 'pending_received';
                            }
                        }

                        return { 
                            username: otherUser, 
                            relationStatus: status,
                            avatarUrl: otherUserObj.avatarUrl || null 
                        };
                    });

                    res.end(JSON.stringify({ status: 'SUCCESS', users: usersWithStatus }));
                } else if (action === 'search') {
                    const query = (searchTarget || '').toLowerCase().trim();
                    if (!query) {
                        res.end(JSON.stringify({ status: 'SUCCESS', users: [] }));
                        return;
                    }

                    let relaciones = leerJson(DB_RELATIONS);
                    let matches = usuarios.filter(u => 
                        u.username.toLowerCase().includes(query) && 
                        u.username.toLowerCase() !== (username || '').toLowerCase()
                    );

                    matches.sort((a, b) => {
                        let aStarts = a.username.toLowerCase().startsWith(query);
                        let bStarts = b.username.toLowerCase().startsWith(query);
                        if (aStarts && !bStarts) return -1;
                        if (!aStarts && bStarts) return 1;
                        return a.username.localeCompare(b.username);
                    });

                    let usersWithStatus = matches.map(otherUserObj => {
                        let otherUser = otherUserObj.username;
                        let rel = relaciones.find(r => 
                            (r.user1 === username && r.user2 === otherUser) || 
                            (r.user1 === otherUser && r.user2 === username)
                        );

                        let status = 'none';
                        if (rel) {
                            if (rel.status === 'friends') {
                                status = 'friends';
                            } else if (rel.status === 'pending') {
                                status = (rel.sender === username) ? 'pending_sent' : 'pending_received';
                            }
                        }

                        return { 
                            username: otherUser, 
                            relationStatus: status,
                            avatarUrl: otherUserObj.avatarUrl || null 
                        };
                    });

                    res.end(JSON.stringify({ status: 'SUCCESS', users: usersWithStatus }));
                } else if (action === 'send_request') {
                    let relaciones = leerJson(DB_RELATIONS);
                    let relExistente = relaciones.find(r => 
                        (r.user1 === username && r.user2 === targetUser) || 
                        (r.user1 === targetUser && r.user2 === username)
                    );

                    if (!relExistente) {
                        relaciones.push({
                            user1: username,
                            user2: targetUser,
                            sender: username,
                            status: 'pending'
                        });
                        guardarJson(DB_RELATIONS, relaciones);
                    }
                    res.end(JSON.stringify({ status: 'SUCCESS', message: 'Solicitud enviada' }));
                } else if (action === 'get_pending_requests') {
                    let relaciones = leerJson(DB_RELATIONS);
                    let pending = [];

                    relaciones.forEach(r => {
                        if (r.status === 'pending') {
                            if (r.user1 === username && r.sender !== username) pending.push(r.user2);
                            if (r.user2 === username && r.sender !== username) pending.push(r.user1);
                        }
                    });

                    res.end(JSON.stringify({ status: 'SUCCESS', requests: pending }));
                } else if (action === 'respond_request') {
                    let relaciones = leerJson(DB_RELATIONS);
                    let target = targetUser || sender;
                    let dec = decision || response;

                    let index = relaciones.findIndex(r => 
                        (r.user1 === username && r.user2 === target) || 
                        (r.user1 === target && r.user2 === username) ||
                        (r.user1 === sender && r.user2 === receiver) ||
                        (r.user1 === receiver && r.user2 === sender)
                    );

                    if (index !== -1) {
                        if (dec === 'accept') {
                            relaciones[index].status = 'friends';
                        } else {
                            relaciones.splice(index, 1);
                        }
                        guardarJson(DB_RELATIONS, relaciones);
                    }
                    res.end(JSON.stringify({ status: 'SUCCESS', message: 'Respuesta procesada' }));
                } else if (action === 'send_message') {
                    let mensajes = leerJson(DB_MESSAGES);
                    const tipoMensaje = data.type || 'text';

                    const nuevoMensaje = { 
                        sender, 
                        receiver, 
                        message, 
                        type: tipoMensaje,
                        replyToText: replyToText || '',
                        replyToSender: replyToSender || '',
                        timestamp: Date.now(),
                        read: false
                    };
                    mensajes.push(nuevoMensaje);
                    guardarJson(DB_MESSAGES, mensajes);

                    let targetUserObj = usuarios.find(u => u.username === receiver);
                    if (targetUserObj && targetUserObj.fcmToken) {
                        const payload = {
                            token: targetUserObj.fcmToken,
                            data: {
                                sender: sender,
                                message: tipoMensaje === 'text' ? message : '[Archivo Multimedia]'
                            },
                            notification: {
                                title: sender,
                                body: tipoMensaje === 'text' ? message : 'Te ha enviado un archivo multimedia'
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
                            .then(response => console.log(`[PUSH NOTIFICATION] Enviada con éxito a ${receiver}:`, response))
                            .catch(error => console.log(`[PUSH ERROR] Falló al enviar notificación a ${receiver}:`, error));
                    }

                    res.end(JSON.stringify({ status: 'SUCCESS', message: 'Mensaje enviado' }));
                } else if (action === 'get_messages') {
                    let mensajes = leerJson(DB_MESSAGES);
                    let chatMessages = mensajes.filter(m => 
                        (m.sender === sender && m.receiver === receiver) || 
                        (m.sender === receiver && m.receiver === sender)
                    );
                    res.end(JSON.stringify({ status: 'SUCCESS', messages: chatMessages }));
                } else if (action === 'mark_as_read') {
                    let mensajes = leerJson(DB_MESSAGES);
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
                    let relaciones = leerJson(DB_RELATIONS);
                    let amigosValidos = new Set();

                    relaciones.forEach(r => {
                        if (r.status === 'friends') {
                            if (r.user1 === username) amigosValidos.add(r.user2);
                            if (r.user2 === username) amigosValidos.add(r.user1);
                        }
                    });

                    let mensajes = leerJson(DB_MESSAGES);
                    let userChats = {};

                    amigosValidos.forEach(amigo => {
                        let friendObj = usuarios.find(u => u.username === amigo);
                        userChats[amigo] = {
                            withUser: amigo,
                            lastMessage: "Toca para iniciar conversación",
                            timestamp: 0,
                            hasUnread: false,
                            avatarUrl: friendObj ? friendObj.avatarUrl : null
                        };
                    });

                    mensajes.forEach(m => {
                        if (m.sender === username || m.receiver === username) {
                            let otherUser = (m.sender === username) ? m.receiver : m.sender;
                            
                            if (amigosValidos.has(otherUser)) {
                                let previewText = m.type === 'text' ? m.message : (m.type === 'video' ? '[Video]' : '[GIF]');
                                let friendObj = usuarios.find(u => u.username === otherUser);
                                if (m.timestamp > userChats[otherUser].timestamp) {
                                    let unread = (m.receiver === username && !m.read);
                                    userChats[otherUser] = {
                                        withUser: otherUser,
                                        lastMessage: previewText,
                                        timestamp: m.timestamp,
                                        hasUnread: unread,
                                        avatarUrl: friendObj ? friendObj.avatarUrl : null
                                    };
                                } else {
                                    if (m.receiver === username && !m.read) {
                                        userChats[otherUser].hasUnread = true;
                                    }
                                }
                            }
                        }
                    });

                    let conversations = Object.values(userChats).sort((a, b) => b.timestamp - a.timestamp);
                    res.end(JSON.stringify({ status: 'SUCCESS', conversations: conversations }));
                } else if (action === 'get_publications') {
                    let publicaciones = leerJson(DB_PUBLICATIONS);
                    let publicacionesConDetalles = publicaciones.map(post => {
                        let autorObj = usuarios.find(u => u.username === post.username);
                        let avatarUrl = autorObj ? autorObj.avatarUrl : null;
                        let likesArray = post.likes || [];
                        let isLiked = likesArray.includes(username);

                        return {
                            id: post.id,
                            username: post.username,
                            avatarUrl: avatarUrl,
                            mediaUrl: post.mediaUrl,
                            caption: post.caption || '',
                            likesCount: likesArray.length,
                            isLiked: isLiked,
                            timestamp: post.timestamp
                        };
                    });

                    publicacionesConDetalles.sort((a, b) => b.timestamp - a.timestamp);
                    res.end(JSON.stringify({
                        status: 'SUCCESS',
                        publications: publicacionesConDetalles
                    }));
                } else if (action === 'toggle_like') {
                    let publicaciones = leerJson(DB_PUBLICATIONS);
                    let postIndex = publicaciones.findIndex(p => p.id === postId);

                    if (postIndex !== -1) {
                        if (!publicaciones[postIndex].likes) {
                            publicaciones[postIndex].likes = [];
                        }

                        let likes = publicaciones[postIndex].likes;
                        let userIndex = likes.indexOf(username);

                        if (userIndex === -1) {
                            likes.push(username);
                        } else {
                            likes.splice(userIndex, 1);
                        }

                        guardarJson(DB_PUBLICATIONS, publicaciones);
                    }

                    res.end(JSON.stringify({ status: 'SUCCESS', message: 'Like actualizado' }));
                } else {
                    res.end(JSON.stringify({ status: 'ERROR', message: 'Acción no válida' }));
                }
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ERROR', message: 'JSON inválido' }));
            }
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Servidor ChikiChat activo');
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Servidor de ChikiChat corriendo en http://localhost:${PORT}`);
});