require('./system/settings.js');
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const app = express();
const { sendEmailVps, createVPS } = require('./system/cvps');
app.use(express.json());
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs'); 
app.use(express.static('public'));

function getProducts() {
    try {
        const filePath = path.join(__dirname, 'produce.json');
        if (!fs.existsSync(filePath)) {
            console.error('Error: File produce.json tidak ditemukan.');
            return [];
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Gagal membaca produce.json:', error);
        return [];
    }
}

function listVps() {
    try {
        const filePath = path.join(__dirname, 'vps.json');
        if (!fs.existsSync(filePath)) {
            console.error('Error: File vps.json tidak ditemukan.');
            return [];
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Gagal membaca vps.json:', error);
        return [];
    }
}

function generateRandomPassword() {
    return Math.random().toString(36).substr(2, 5);
}

function formatDate(date) {
    const options = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
    const formatted = date.toLocaleDateString('id-ID', options);
    const withoutComma = formatted.replace(',', '');
    const capitalized = withoutComma.split(' ').map(word => {
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
    return capitalized;
}

async function getTransactions() {
    try {
        const response = await axios.get(RAW_GITHUB_URL);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            await saveTransactions([]);
            return [];
        }
        console.error('Error fetching transactions:', error.message);
        return [];
    }
}

async function saveTransactions(transactions) {
    try {
        const content = Buffer.from(JSON.stringify(transactions, null, 2)).toString('base64');
        const getFile = await axios.get(GITHUB_API, {
            headers: { Authorization: `token ${GITHUB_TOKEN}` }
        }).catch(() => null);
        
        const data = {
            message: 'Update transactions',
            content: content,
            branch: 'main',
            sha: getFile ? getFile.data.sha : undefined
        };
        
        await axios.put(GITHUB_API, data, {
            headers: { Authorization: `token ${GITHUB_TOKEN}` }
        });
        console.log('Transactions saved to GitHub');
    } catch (error) {
        console.error('Error saving transactions:', error.message);
    }
}

app.get('/trx/invoice/:id', async (req, res) => {
    const transactionId = req.params.id;
    let transaction = null;
    let retries = 5;
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (let i = 0; i < retries; i++) {
        const transactions = await getTransactions();
        transaction = transactions.find(t => t.id == transactionId);
        
        if (transaction) break;
        await delay(2000);
    }

    if (!transaction) {
        return res.status(404).send('Transaksi tidak ditemukan.');
    }

    res.render('vpsvoic', { transaction });
});

app.get("/api/create-vps", async (req, res) => {
    const { email, hostname, size, image, region } = req.query;

    try {
        let result = await createVPS({ email, hostname, size, image, region });

        if (result.success) {
            res.status(200).json({ message: 'Vps berhasil dibuat.', data: result.data });
            sendEmailVps(email, hostname, result.data.ip, result.data.password, image, size, region)
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        res.status(500).json({ error: "Terjadi kesalahan saat membuat VPS." });
        console.log(error)
    }
});

app.get('/invoice/:id', async (req, res) => {
    const transactionId = req.params.id;
    const transactions = await getTransactions();
    const transaction = transactions.find(t => t.id === transactionId);
    if (!transaction) {
        return res.status(404).send('Transaksi tidak ditemukan.');
    }
    res.render('invoice', { transaction });
});

app.get('/trx/checkout', async (req, res) => {
    const { price, hostname, email } = req.query;

    if (!price || !hostname || !email) {
        console.error('Field tidak lengkap:', req.query);
        return res.status(400).json({ error: 'Semua field harus diisi.' });
    }

    const products = listVps();
    const product = products.find(p => Number(p.price) === Number(price));

    if (!product) {
        console.error('Produk tidak ditemukan dengan harga:', price);
        return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    }

    const adminFee = Math.floor(Math.random() * (100 - 50 + 1)) + 50;
    const amountWithFee = product.price + adminFee;

    try {
        // 🔥 Panggil API createpayment Orkut
        const response = await axios.get(`https://orderkuota-eight.vercel.app/api/orkut/createpayment`, {
            params: {
                apikey: global.restapi,
                amount: amountWithFee,
                codeqr: global.codeqr
            }
        });

        if (!response.data.status) {
            throw new Error('Gagal mendapatkan QR dari API pembayaran.');
        }

        const qrData = response.data.result;
        const transactions = await getTransactions();
        const transactionId = qrData.transactionId;

        const newTransaction = {
            id: transactionId,
            hostname,
            email,
            size: product.size,
            image: product.image,
            originalAmount: product.price,
            adminFee,
            amount: amountWithFee,
            qrImageUrl: qrData.qrImageUrl,
            qrString: qrData.qrString,
            expirationTime: qrData.expirationTime,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        transactions.push(newTransaction);
        saveTransactions(transactions);

        res.json({
            status: true,
            transactionId: transactionId,
            amount: newTransaction.amount,
            qrImageUrl: newTransaction.qrImageUrl,
            expirationTime: newTransaction.expirationTime
        });
    } catch (error) {
        console.error('Error during checkout:', error.message);
        res.status(500).json({ error: 'Terjadi kesalahan saat melakukan checkout.' });
    }
});

app.get('/api/checkout', async (req, res) => {
    const { username, email, price } = req.query;

    if (!username || !email || !price) {
        console.error('Field tidak lengkap:', req.query);
        return res.status(400).json({ error: 'Semua field harus diisi.' });
    }

    const products = getProducts();
    const product = products.find(p => Number(p.price) === Number(price));

    if (!product) {
        console.error('Produk tidak ditemukan dengan harga:', price);
        return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    }

    // random biaya admin
    const adminFee = Math.floor(Math.random() * (100 - 50 + 1)) + 50;
    const amountWithFee = product.price + adminFee;

    try {
        // 🔥 API createpayment Orkut
        const response = await axios.get(`https://orderkuota-eight.vercel.app/api/orkut/createpayment`, {
            params: {
                apikey: global.restapi, // pake env
                amount: amountWithFee,
                codeqr: global.codeqr
            }
        });

        if (!response.data.status) {
            return res.status(400).json({ error: 'Gagal mendapatkan QR dari API pembayaran.' });
        }

        const qrData = response.data.result;
        const transactions = getTransactions();
        const transactionId = qrData.transactionId;

        const newTransaction = {
            id: transactionId,
            username,
            email,
            memory: product.memory,
            disk: product.disk,
            cpu: product.cpu,
            originalAmount: product.price,
            adminFee,
            amount: amountWithFee,
            qrImageUrl: qrData.qrImageUrl,
            qrString: qrData.qrString, // simpen juga
            expirationTime: qrData.expirationTime,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        transactions.push(newTransaction);
        saveTransactions(transactions);

        res.json({
            status: true,
            transactionId,
            amount: newTransaction.amount,
            qrImageUrl: newTransaction.qrImageUrl,
            qrString: newTransaction.qrString,
            expirationTime: newTransaction.expirationTime
        });
    } catch (error) {
        console.error('Error during checkout:', error.message);
        res.status(500).json({ error: 'Terjadi kesalahan saat melakukan checkout.' });
    }
});

app.get('/api/check-status/:id', async (req, res) => {
    const transactionId = req.params.id;
    const transactions = await getTransactions();
    const transactionIndex = transactions.findIndex(t => t.id === transactionId);

    if (transactionIndex === -1) {
        return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    }

    const transaction = transactions[transactionIndex];

    // Kalau udah sukses jangan cek lagi
    if (transaction.status === 'succeeded') {
        return res.json({ status: 'succeeded' });
    }

    try {
        // 🔥 Panggil API Orkut cekstatus
        const url = `https://orderkuota-eight.vercel.app/api/orkut/cekstatus?apikey=${global.restapi}&username=${global.userOrkut}&authtoken=${global.tokenOrkut}`;
        const { data } = await axios.get(url);

        if (!data.status) {
            return res.status(400).json({ error: 'Gagal ambil data dari Orkut' });
        }

        const trxStatus = data.data.transaction_status;

        // Map status dari Orkut ke sistem lo
        let mappedStatus = 'pending';
        if (trxStatus === 'SUCCEEDED') mappedStatus = 'succeeded';
        if (trxStatus === 'FAILED') mappedStatus = 'failed';
        if (trxStatus === 'IN') mappedStatus = 'pending';

        // Update transaksi kalau ada perubahan
        if (transactions[transactionIndex].status !== mappedStatus) {
            transactions[transactionIndex].status = mappedStatus;
            transactions[transactionIndex].updatedAt = formatDate(new Date());
            saveTransactions(transactions);
        }

        res.json({ 
            status: transactions[transactionIndex].status,
            detail: data.data // biar client dapet detail dari Orkut juga
        });
    } catch (error) {
        console.error('Error checking payment status:', error.message);
        res.status(500).json({ error: 'Terjadi kesalahan saat memeriksa status pembayaran.' });
    }
});

async function createAccountAndServer(email, username, memory, disk, cpu) {
    try {
        let password = generateRandomPassword();
        let response = await fetch(`${domain}/api/application/users`, {
            method: 'POST',
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apikey}`
            },
            body: JSON.stringify({
                email: email,
                username: username,
                first_name: username,
                last_name: username,
                language: "en",
                password: password
            })
        });

        let data = await response.json();
        if (data.errors) return;
        let user = data.attributes;

        let eggResponse = await fetch(`${domain}/api/application/nests/5/eggs/${egg}`, {
            method: 'GET',
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apikey}`
            }
        });

        let eggData = await eggResponse.json();
        let startup_cmd = eggData.attributes.startup;

        let serverResponse = await fetch(`${domain}/api/application/servers`, {
            method: 'POST',
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apikey}`
            },
            body: JSON.stringify({
                name: username,
                description: " ",
                user: user.id,
                egg: parseInt(egg),
                docker_image: "ghcr.io/parkervcp/yolks:nodejs_18",
                startup: startup_cmd,
                environment: {
                    INST: "npm",
                    USER_UPLOAD: "0",
                    AUTO_UPDATE: "0",
                    CMD_RUN: "npm start"
                },
                limits: {
                    memory: memory,
                    swap: 0,
                    disk: disk,
                    io: 500,
                    cpu: cpu
                },
                feature_limits: {
                    databases: 5,
                    backups: 5,
                    allocations: 1
                },
                deploy: {
                    locations: [parseInt(location)],
                    dedicated_ip: false,
                    port_range: []
                }
            })
        });

        let serverData = await serverResponse.json();
        if (serverData.errors) return;
        let server = serverData.attributes;

        sendEmail(email, user, password, server);

    } catch (error) {
        console.error("Error:", error);
    }
}

function sendEmail(email, user, password, server) {
    let transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: `${mail}`,
            pass: `${pass}`
        }
    });

    let mailOptions = {
        from: `${mail}`,
        to: email,
        subject: 'Account and Server Details',
        html: `
            <h3>Hi ${user.username},</h3>
            <p>Your account and server have been successfully created. Here are the details:</p>
            <ul>
                <li><strong>Username:</strong> ${user.username}</li>
                <li><strong>Password:</strong> ${password}</li>
                <li><strong>Server Memory:</strong> ${server.limits.memory} MB</li>
                <li><strong>Server Disk:</strong> ${server.limits.disk} MB</li>
                <li><strong>Server CPU:</strong> ${server.limits.cpu}%</li>
            </ul>
            <p>Please login to your server using the following URL: ${domain}</p>
        `
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error("Error sending email:", error);
        } else {
            console.log("Email sent:", info.response);
        }
    });
}

app.get('/', (req, res) => {
    const products = getProducts();
    res.render('cpanel', { products });
});

app.get('/vps', (req, res) => {
    const products = listVps();
    res.render('vps', { products });
});

app.get('/api/create-panel', async (req, res) => {
    const { email, username, memory, disk, cpu } = req.query;

    if (!email || !username || !memory || !disk || !cpu) {
        return res.status(400).json({ error: 'Semua parameter (email, username, memory, disk, cpu) harus diisi.' });
    }

    try {
        await createAccountAndServer(email, username, memory, disk, cpu);
        res.status(200).json({ message: 'Akun dan server berhasil dibuat.' });
    } catch (error) {
        res.status(500).json({ error: 'Terjadi kesalahan saat membuat panel.' });
    }
});

const PORT = process.env.PORT || 2002;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});