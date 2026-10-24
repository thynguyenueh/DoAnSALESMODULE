const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

if (!ADMIN_PASSWORD_HASH || !SESSION_SECRET) {
    throw new Error('ADMIN_PASSWORD_HASH và ADMIN_SESSION_SECRET phải được cấu hình trong .env');
}

function verifyAdminPassword(password) {
    const [algorithm, saltHex, hashHex] = ADMIN_PASSWORD_HASH.split('$');
    if (algorithm !== 'scrypt' || !/^[a-f\d]+$/i.test(saltHex || '') || !/^[a-f\d]+$/i.test(hashHex || '')) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createSessionToken(username) {
    const payload = Buffer.from(JSON.stringify({
        username,
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function readSession(req) {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => {
        const separator = part.indexOf('=');
        return separator < 0 ? ['', ''] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
    }));
    const token = cookies.sales_module_session;
    if (!token) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
    let actual;
    try {
        actual = Buffer.from(signature, 'base64url');
    } catch (error) {
        return null;
    }
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    try {
        const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (session.username !== ADMIN_USERNAME || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null;
        return session;
    } catch (error) {
        return null;
    }
}

function setSessionCookie(res, token, maxAge) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sales_module_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username !== ADMIN_USERNAME || typeof password !== 'string' || !verifyAdminPassword(password)) {
        return res.status(401).json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    }
    setSessionCookie(res, createSessionToken(ADMIN_USERNAME), SESSION_TTL_SECONDS);
    res.json({ success: true, username: ADMIN_USERNAME });
});

app.get('/api/auth/session', (req, res) => {
    const session = readSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Phiên đăng nhập đã hết hạn.' });
    res.json({ success: true, username: session.username });
});

app.post('/api/auth/logout', (req, res) => {
    setSessionCookie(res, '', 0);
    res.json({ success: true });
});

app.use('/api', (req, res, next) => {
    const session = readSession(req);
    if (!session) return res.status(401).json({ success: false, message: 'Vui lòng đăng nhập để tiếp tục.' });
    req.user = { username: session.username };
    next();
});

app.use((req, res, next) => {
    if (req.path === '/login.html' || ['/css/', '/img/', '/js/', '/vendor/'].some(prefix => req.path.startsWith(prefix))) {
        return next();
    }
    const session = readSession(req);
    if (session) {
        req.user = { username: session.username };
        return next();
    }
    res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
});

app.use(express.static(path.join(__dirname, './')));

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'salesmodule',
    password: process.env.DB_PASSWORD || '1234',
    port: process.env.DB_PORT || 5432,
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Lỗi kết nối CSDL PostgreSQL:', err.stack);
    } else {
        console.log('✅ Đã kết nối thành công tới PostgreSQL!');
        release();
    }
});

// REST API ENDPOINTS

app.get('/api/stock', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM v_product_stock');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/debt-summary', async (req, res) => {
    try {
        const result = await pool.query(`
            WITH eligible_orders AS (
                SELECT so.id, so.customerid, so.totalamount, orders.total_refund
                FROM sales_orders so
                JOIN v_sales_orders_list orders ON orders.id = so.id
                WHERE so.isactive = true
                  AND orders.status IN ('Pending', 'Paid', 'Delivered')
            ), customer_balances AS (
                SELECT eligible.customerid,
                       SUM(GREATEST(eligible.totalamount - eligible.total_refund, 0)) AS total_bought,
                       SUM(COALESCE(receipts.amount, 0) - COALESCE(disbursements.amount, 0)) AS total_paid
                FROM eligible_orders eligible
                LEFT JOIN LATERAL (
                    SELECT SUM(pr.amount) AS amount
                    FROM payment_receipts pr
                    WHERE pr.orderid = eligible.id AND pr.isactive = true
                ) receipts ON true
                LEFT JOIN LATERAL (
                    SELECT SUM(cd.amount) AS amount
                    FROM cash_disbursements cd
                    JOIN sales_returns sr ON sr.id = cd.returnid
                    WHERE sr.orderid = eligible.id AND sr.isactive = true AND cd.isactive = true
                ) disbursements ON true
                GROUP BY eligible.customerid
            )
            SELECT c.id AS customer_id, c.code AS customer_code, c.name AS customer_name,
                   COALESCE(balances.total_bought, 0) AS total_bought,
                   COALESCE(balances.total_paid, 0) AS total_paid,
                   GREATEST(COALESCE(balances.total_bought, 0) - COALESCE(balances.total_paid, 0), 0) AS remaining_debt
            FROM customers c
            LEFT JOIN customer_balances balances ON balances.customerid = c.id
            WHERE c.isactive = true
            ORDER BY remaining_debt DESC, c.name
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/dashboard/reports', async (req, res) => {
    try {
        const result = await pool.query('SELECT fn_get_dashboard_summary() AS data');
        res.json({ success: true, data: result.rows[0].data });
    } catch (err) {
        console.error('Lỗi tải báo cáo Dashboard:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/dashboard/revenue', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM fn_get_dashboard_revenue_report()');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Lỗi tải báo cáo doanh thu:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/dashboard/detail', async (req, res) => {
    const { report } = req.query;
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const customerId = req.query.customerId || null;
    const productId = req.query.productId || null;
    const warehouseId = req.query.warehouseId || null;
    const minStock = req.query.minStock == null || req.query.minStock === '' ? null : Number(req.query.minStock);
    const limit = req.query.limit == null ? 50 : Number(req.query.limit);

    try {
        let dataRows;
        if (report === 'revenue') {
            const result = await pool.query(`
                WITH order_returns AS (
                    SELECT orderid, SUM(totalrefund) AS total_refund
                    FROM sales_returns
                    WHERE isactive = true
                    GROUP BY orderid
                )
                SELECT TO_CHAR(DATE_TRUNC('month', so.docdate), 'YYYY-MM') AS month,
                       COUNT(*)::integer AS order_count,
                       COALESCE(SUM(so.totalamount), 0) AS gross_revenue,
                       COALESCE(SUM(so.totalrefund + COALESCE(returns.total_refund, 0)), 0) AS total_refund,
                       COALESCE(SUM(GREATEST(
                           so.totalamount - so.totalrefund - COALESCE(returns.total_refund, 0), 0
                       )), 0) AS net_revenue
                FROM sales_orders so
                LEFT JOIN order_returns returns ON returns.orderid = so.id
                WHERE so.isactive = true
                  AND so.status IN ('Delivered', 'Completed')
                  AND ($1::date IS NULL OR so.docdate >= $1::date)
                  AND ($2::date IS NULL OR so.docdate < $2::date + INTERVAL '1 day')
                  AND ($3::integer IS NULL OR so.customerid = $3::integer)
                GROUP BY DATE_TRUNC('month', so.docdate)
                ORDER BY DATE_TRUNC('month', so.docdate) DESC
                LIMIT $4::integer
            `, [fromDate, toDate, customerId, limit]);
            dataRows = result.rows;
        } else if (report === 'products') {
            const result = await pool.query(`
                WITH returned_items AS (
                    SELECT sr.orderid, srd.productid, srd.warehouseid,
                           SUM(srd.quantityreturned) AS quantity_returned
                    FROM sales_return_details srd
                    JOIN sales_returns sr ON sr.id = srd.returnid
                    WHERE sr.isactive = true AND srd.isactive = true
                    GROUP BY sr.orderid, srd.productid, srd.warehouseid
                ), item_sales AS (
                    SELECT p.id AS product_id, p.code AS product_code, p.name AS product_name,
                           sod.warehouseid AS warehouse_id, w.name AS warehouse_name,
                           sod.quantity, sod.unitprice, sod.discountamount,
                           COALESCE(returned.quantity_returned, 0) AS quantity_returned
                    FROM sales_order_details sod
                    JOIN sales_orders so ON so.id = sod.orderid
                    JOIN products p ON p.id = sod.productid
                    LEFT JOIN warehouses w ON w.id = sod.warehouseid
                    LEFT JOIN returned_items returned
                      ON returned.orderid = sod.orderid
                     AND returned.productid = sod.productid
                     AND returned.warehouseid IS NOT DISTINCT FROM sod.warehouseid
                    WHERE so.isactive = true AND sod.isactive = true
                      AND so.status IN ('Paid', 'Delivered', 'Completed')
                      AND ($1::date IS NULL OR so.docdate >= $1::date)
                      AND ($2::date IS NULL OR so.docdate < $2::date + INTERVAL '1 day')
                      AND ($3::varchar IS NULL OR so.status = $3::varchar
                           OR ($3::varchar = 'Returned' AND returned.quantity_returned > 0))
                      AND ($4::integer IS NULL OR so.customerid = $4::integer)
                      AND ($5::integer IS NULL OR p.id = $5::integer)
                      AND ($6::integer IS NULL OR sod.warehouseid = $6::integer)
                      AND ($7::text = '' OR p.code ILIKE '%' || $7::text || '%'
                           OR p.name ILIKE '%' || $7::text || '%'
                           OR w.name ILIKE '%' || $7::text || '%')
                )
                SELECT product_code, product_name, warehouse_name,
                       SUM(GREATEST(quantity - quantity_returned, 0)) AS net_quantity_sold,
                       SUM(quantity_returned) AS quantity_returned,
                       SUM(quantity * unitprice - discountamount) AS gross_sales,
                       SUM(quantity_returned * unitprice
                           - discountamount * quantity_returned / NULLIF(quantity, 0)) AS refund_amount,
                       SUM(quantity * unitprice - discountamount)
                         - SUM(quantity_returned * unitprice
                               - discountamount * quantity_returned / NULLIF(quantity, 0)) AS net_sales
                FROM item_sales
                GROUP BY product_id, product_code, product_name, warehouse_id, warehouse_name
                ORDER BY net_sales DESC, product_name, warehouse_name
                LIMIT $8::integer
            `, [fromDate, toDate, status, customerId, productId, warehouseId, search, limit]);
            dataRows = result.rows;
        } else if (report === 'customers') {
            const result = await pool.query(`
                WITH order_returns AS (
                    SELECT orderid, SUM(totalrefund) AS total_refund
                    FROM sales_returns
                    WHERE isactive = true
                    GROUP BY orderid
                ), customer_totals AS (
                    SELECT c.id AS customer_id, c.code AS customer_code, c.name AS customer_name,
                           COUNT(so.id)::integer AS order_count,
                           COALESCE(SUM(so.totalamount), 0) AS gross_revenue,
                           COALESCE(SUM(so.totalrefund + COALESCE(returns.total_refund, 0)), 0) AS total_refund,
                           COALESCE(SUM(GREATEST(
                               so.totalamount - so.totalrefund - COALESCE(returns.total_refund, 0), 0
                           )), 0) AS net_revenue
                    FROM sales_orders so
                    JOIN customers c ON c.id = so.customerid
                    LEFT JOIN order_returns returns ON returns.orderid = so.id
                    WHERE so.isactive = true
                      AND so.status IN ('Delivered', 'Completed')
                      AND ($1::date IS NULL OR so.docdate >= $1::date)
                      AND ($2::date IS NULL OR so.docdate < $2::date + INTERVAL '1 day')
                    GROUP BY c.id, c.code, c.name
                ), ranked_customers AS (
                    SELECT customer_totals.*,
                           DENSE_RANK() OVER (ORDER BY net_revenue DESC) AS revenue_rank,
                           ROUND(100 * net_revenue / NULLIF(SUM(net_revenue) OVER (), 0), 2) AS revenue_share
                    FROM customer_totals
                )
                SELECT customer_id, customer_code, customer_name, order_count,
                       gross_revenue, total_refund, net_revenue, revenue_rank, revenue_share
                FROM ranked_customers
                WHERE ($3::integer IS NULL OR customer_id = $3::integer)
                  AND ($4::text = '' OR customer_code ILIKE '%' || $4::text || '%'
                       OR customer_name ILIKE '%' || $4::text || '%')
                ORDER BY revenue_rank, customer_name
                LIMIT $5::integer
            `, [fromDate, toDate, customerId, search, limit]);
            dataRows = result.rows;
        } else {
            const result = await pool.query(
                'SELECT fn_get_dashboard_report_detail($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS data',
                [report, fromDate, toDate, status, search, customerId, productId, warehouseId, minStock, limit]
            );
            dataRows = result.rows[0].data || [];
        }
        res.json({ success: true, report, count: dataRows.length, data: dataRows, chartData: null });
    } catch (err) {
        console.error('Lỗi tải báo cáo chi tiết Dashboard:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/dashboard/customer-ranking', async (req, res) => {
    const yearParam = req.query.year;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    if (yearParam != null && !/^\d{4}$/.test(String(yearParam))) {
        return res.status(400).json({ success: false, message: 'Năm báo cáo không hợp lệ!' });
    }
    if (search.length > 100) {
        return res.status(400).json({ success: false, message: 'Từ khóa khách hàng không được vượt quá 100 ký tự!' });
    }

    try {
        const availableYearsResult = await pool.query('SELECT * FROM fn_get_available_order_years()');
        const availableYears = availableYearsResult.rows.map(row => row.year);

        const requestedYear = yearParam == null ? new Date().getFullYear() : Number(yearParam);
        if (!Number.isInteger(requestedYear) || requestedYear < 1900 || requestedYear > 2200) {
            return res.status(400).json({ success: false, message: 'Năm báo cáo không hợp lệ!' });
        }

        const year = availableYears.includes(requestedYear)
            ? requestedYear
            : (yearParam == null && availableYears.length ? availableYears[0] : requestedYear);

        const result = await pool.query(
            'SELECT * FROM fn_get_customer_revenue_ranking($1, $2)',
            [year, search]
        );

        res.json({
            success: true,
            year,
            years: availableYears,
            data: result.rows
        });
    } catch (err) {
        console.error('Lỗi tải xếp hạng doanh thu khách hàng:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/customers', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, code, name, phone FROM customers WHERE isactive = true ORDER BY id DESC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, code, name FROM products WHERE isactive = true ORDER BY id DESC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/warehouses', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, code, name FROM warehouses WHERE isactive = true ORDER BY id ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

const catalogConfig = {
    customers: {
        fields: ['code', 'name', 'phone', 'email', 'address'],
        required: ['code', 'name'],
        listFields: 'id, code, name, phone, email, address, isactive, createdat, updatedat'
    },
    products: {
        fields: ['code', 'name'],
        required: ['code', 'name'],
        listFields: 'id, code, name, isactive, createdat, updatedat'
    },
    warehouses: {
        fields: ['code', 'name', 'location'],
        required: ['code', 'name'],
        listFields: 'id, code, name, location, isactive, createdat, updatedat'
    }
};

app.get('/api/catalogs/:entity', async (req, res) => {
    if (!Object.hasOwn(catalogConfig, req.params.entity)) {
        return res.status(404).json({ success: false, message: 'Loại danh mục không hợp lệ!' });
    }
    const config = catalogConfig[req.params.entity];
    try {
        const result = await pool.query(
            `SELECT ${config.listFields} FROM ${req.params.entity} ORDER BY id DESC`
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/catalogs/:entity', async (req, res) => {
    if (!Object.hasOwn(catalogConfig, req.params.entity)) {
        return res.status(404).json({ success: false, message: 'Loại danh mục không hợp lệ!' });
    }
    const config = catalogConfig[req.params.entity];
    const values = config.fields.map(field => req.body[field] == null ? null : String(req.body[field]).trim());
    if (config.required.some(field => !req.body[field] || !String(req.body[field]).trim())) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ mã và tên!' });
    }
    try {
        const columns = config.fields.join(', ');
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        const result = await pool.query(
            `INSERT INTO ${req.params.entity} (${columns}) VALUES (${placeholders}) RETURNING id`,
            values
        );
        res.status(201).json({ success: true, message: 'Đã tạo danh mục!', id: result.rows[0].id });
    } catch (err) {
        const status = err.code === '23505' ? 409 : 500;
        res.status(status).json({ success: false, message: err.code === '23505' ? 'Mã danh mục đã tồn tại!' : err.message });
    }
});

app.put('/api/catalogs/:entity/:id', async (req, res) => {
    if (!Object.hasOwn(catalogConfig, req.params.entity)) {
        return res.status(404).json({ success: false, message: 'Loại danh mục không hợp lệ!' });
    }
    const config = catalogConfig[req.params.entity];
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ success: false, message: 'Mã danh mục không hợp lệ!' });
    const updates = config.fields.filter(field => Object.hasOwn(req.body, field));
    if (Object.hasOwn(req.body, 'isactive')) updates.push('isactive');
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'Không có thông tin cần cập nhật!' });
    if (Object.hasOwn(req.body, 'isactive') &&
        ![true, false, 'true', 'false'].includes(req.body.isactive)) {
        return res.status(400).json({ success: false, message: 'Trạng thái danh mục không hợp lệ!' });
    }
    for (const field of config.required) {
        if (Object.hasOwn(req.body, field) && !String(req.body[field] || '').trim()) {
            return res.status(400).json({ success: false, message: 'Mã và tên không được để trống!' });
        }
    }
    const values = updates.map(field => field === 'isactive'
        ? req.body[field] === true || req.body[field] === 'true'
        : String(req.body[field] == null ? '' : req.body[field]).trim());
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const current = await client.query(
            `SELECT ${[...config.fields, 'isactive'].join(', ')}
             FROM ${req.params.entity}
             WHERE id = $1
             FOR UPDATE`,
            [Number(req.params.id)]
        );
        if (current.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Không tìm thấy danh mục!' });
        }

        const oldValues = Object.fromEntries(updates.map(field => [field, current.rows[0][field]]));
        const newValues = Object.fromEntries(updates.map((field, index) => [field, values[index]]));
        const assignments = updates.map((field, index) => `${field} = $${index + 1}`).join(', ');
        await client.query(
            `UPDATE ${req.params.entity} SET ${assignments} WHERE id = $${values.length + 1} RETURNING id`,
            [...values, Number(req.params.id)]
        );
        await client.query(
            `INSERT INTO catalog_audit_log (entity, record_id, old_values, new_values, changed_by)
             VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
            [req.params.entity, Number(req.params.id), JSON.stringify(oldValues), JSON.stringify(newValues), req.user.username]
        );
        await client.query('COMMIT');
        res.json({ success: true, message: 'Đã cập nhật danh mục và ghi nhật ký thay đổi!' });
    } catch (err) {
        if (client) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('Lỗi rollback cập nhật danh mục:', rollbackError);
            }
        }
        console.error('Lỗi cập nhật danh mục và ghi nhật ký:', err);
        const status = err.code === '23505' ? 409 : 500;
        res.status(status).json({ success: false, message: err.code === '23505' ? 'Mã danh mục đã tồn tại!' : err.message });
    } finally {
        if (client) client.release();
    }
});

// 1. TẠO ĐƠN HÀNG MỚI (TỰ ĐỘNG TRỪ KHO TYPE = 2)
app.post('/api/orders', async (req, res) => {
    const { docno, customerid, items } = req.body || {};
    if (typeof docno !== 'string' || !docno.trim()) {
        return res.status(400).json({ success: false, message: 'Mã đơn hàng không hợp lệ!' });
    }
    if (!Number.isInteger(Number(customerid)) || Number(customerid) <= 0) {
        return res.status(400).json({ success: false, message: 'Vui lòng chọn khách hàng hợp lệ!' });
    }
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Đơn hàng phải có ít nhất 1 sản phẩm!' });
    }
    for (const item of items) {
        const quantity = Number(item && item.quantity);
        const unitprice = Number(item && item.unitprice);
        const discountamount = Number(item && item.discountamount || 0);
        if (!item || !Number.isInteger(Number(item.productid)) || Number(item.productid) <= 0 ||
            !Number.isInteger(Number(item.warehouseid)) || Number(item.warehouseid) <= 0 ||
            !Number.isInteger(quantity) || quantity <= 0 ||
            !Number.isFinite(unitprice) || unitprice <= 0 ||
            !Number.isFinite(discountamount) || discountamount < 0 ||
            discountamount > quantity * unitprice) {
            return res.status(400).json({ success: false, message: 'Thông tin sản phẩm hoặc chiết khấu không hợp lệ!' });
        }
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const totalamount = Math.round(items.reduce((sum, item) =>
            sum + Number(item.quantity) * Number(item.unitprice) - Number(item.discountamount || 0), 0) * 100) / 100;
        
        const order = await client.query(
            `INSERT INTO sales_orders (docno, customerid, totalamount, status, createdby)
             VALUES ($1, $2, $3, 'Pending', $4) RETURNING id`,
            [docno.trim(), Number(customerid), totalamount, req.user.username]
        );

        for (const item of items) {
            await client.query(
                `INSERT INTO sales_order_details (orderid, productid, warehouseid, quantity, unitprice, discountamount)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [order.rows[0].id, Number(item.productid), Number(item.warehouseid), Number(item.quantity),
                    Number(item.unitprice), Number(item.discountamount || 0)]
            );

            await client.query(
                `INSERT INTO inventory (docno, productid, warehouseid, quantity, type, createdby)
                 VALUES ($1, $2, $3, $4, 2, $5)`,
                [docno.trim(), Number(item.productid), Number(item.warehouseid), Number(item.quantity), req.user.username]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, message: 'Tạo đơn hàng thành công!', orderId: order.rows[0].id });
    } catch (err) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error('Lỗi rollback tạo đơn hàng:', rollbackError);
            }
        }
        console.error('Lỗi tạo đơn hàng:', err);
        const clientError = ['23503', '23514', '22003'].includes(err.code);
        res.status(err.code === '23505' ? 409 : clientError ? 400 : 500).json({
            success: false,
            message: err.code === '23505' ? 'Mã đơn hàng đã tồn tại!' : err.message
        });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/inventory/movements', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT movement.id, movement.docno, movement.docdate, movement.productid, movement.warehouseid,
                   movement.quantity, movement.type, movement.createdby, movement.createdat,
                   p.code AS product_code, p.name AS product_name,
                   w.code AS warehouse_code, w.name AS warehouse_name
            FROM (
                SELECT inv.id, inv.docno, inv.docdate, inv.productid, inv.warehouseid,
                       inv.quantity, inv.type, inv.createdby, inv.createdat
                FROM inventory inv
                WHERE inv.isactive = true

                UNION ALL

                SELECT srd.id, sr.docno, sr.docdate, srd.productid, srd.warehouseid,
                       srd.quantityreturned AS quantity, 2 AS type, sr.createdby, sr.createdat
                FROM sales_returns sr
                JOIN sales_return_details srd ON srd.returnid = sr.id AND srd.isactive = true
                WHERE sr.isactive = true
                  AND NOT EXISTS (
                      SELECT 1
                      FROM inventory returned_inventory
                      WHERE returned_inventory.isactive = true
                        AND returned_inventory.type = 2
                        AND returned_inventory.docno = sr.docno
                        AND returned_inventory.productid = srd.productid
                        AND returned_inventory.warehouseid = srd.warehouseid
                  )
            ) movement
            JOIN products p ON p.id = movement.productid
            JOIN warehouses w ON w.id = movement.warehouseid
            ORDER BY movement.docdate DESC, movement.id DESC
            LIMIT 500
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/inventory/next-docno', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 'INV-' || TO_CHAR(CURRENT_TIMESTAMP, 'YYYYMMDD') || '-' ||
                   LPAD(NEXTVAL('inventory_docno_seq')::text, 6, '0') AS docno
        `);
        res.json({ success: true, data: { docno: result.rows[0].docno } });
    } catch (err) {
        console.error('Lỗi tạo mã phiếu nhập kho:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/inventory/movements', async (req, res) => {
    const { docno, productid, warehouseid, quantity } = req.body || {};
    const isValidDocNo = typeof docno === 'string' && /^(INV|PN)-[A-Za-z0-9-]+$/.test(docno.trim());

    if (!isValidDocNo ||
        !Number.isInteger(Number(productid)) || Number(productid) <= 0 ||
        !Number.isInteger(Number(warehouseid)) || Number(warehouseid) <= 0 ||
        !Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
        return res.status(400).json({ success: false, message: 'Mã phiếu nhập, sản phẩm, kho hoặc số lượng không hợp lệ!' });
    }
    try {
        const result = await pool.query(`
            INSERT INTO inventory (docno, productid, warehouseid, quantity, type, createdby)
            SELECT $1, p.id, w.id, $4, 1, $5
            FROM products p
            CROSS JOIN warehouses w
            WHERE p.id = $2 AND p.isactive = true
              AND w.id = $3 AND w.isactive = true
            RETURNING id, docno
        `, [docno, Number(productid), Number(warehouseid), Number(quantity), req.user.username]);
        if (result.rowCount === 0) {
            return res.status(400).json({ success: false, message: 'Sản phẩm hoặc kho không tồn tại/đang ngưng hoạt động!' });
        }
        res.status(201).json({ success: true, message: 'Đã ghi nhận phiếu nhập kho!', id: result.rows[0].id, docno: result.rows[0].docno });
    } catch (err) {
        const status = err.code === '23505' ? 409 : 500;
        res.status(status).json({ success: false, message: err.code === '23505' ? 'Mã chứng từ kho đã tồn tại!' : err.message });
    }
});

app.get('/api/finance/receipts', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT pr.id, pr.docno, pr.docdate, pr.orderid, pr.customerid, pr.amount,
                   pr.createdby, pr.createdat, so.docno AS order_docno,
                   c.code AS customer_code, c.name AS customer_name
            FROM payment_receipts pr
            LEFT JOIN sales_orders so ON so.id = pr.orderid
            LEFT JOIN customers c ON c.id = pr.customerid
            WHERE pr.isactive = true
            ORDER BY pr.docdate DESC, pr.id DESC
            LIMIT 500
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/finance/order-balances', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT so.id, so.docno, so.customerid, c.name AS customer_name,
                   so.totalamount,
                   COALESCE(receipts.total_paid, 0) AS total_paid,
                   GREATEST(so.totalamount - COALESCE(receipts.total_paid, 0), 0) AS outstanding_amount
            FROM sales_orders so
            JOIN customers c ON c.id = so.customerid
            LEFT JOIN LATERAL (
                SELECT SUM(pr.amount) AS total_paid
                FROM payment_receipts pr
                WHERE pr.orderid = so.id AND pr.isactive = true
            ) receipts ON true
            WHERE so.isactive = true
              AND so.status IN ('Pending', 'Paid', 'Delivered', 'Completed')
              AND NOT EXISTS (
                  SELECT 1 FROM sales_returns sr
                  WHERE sr.orderid = so.id AND sr.isactive = true
              )
            ORDER BY so.docdate DESC, so.id DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/finance/disbursements', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT cd.id, cd.docno, cd.docdate, cd.returnid, cd.customerid,
                   cd.amount, cd.isactive, sr.docno AS return_docno,
                   so.docno AS order_docno, c.code AS customer_code,
                   c.name AS customer_name
            FROM cash_disbursements cd
            LEFT JOIN sales_returns sr ON sr.id = cd.returnid
            LEFT JOIN sales_orders so ON so.id = sr.orderid
            LEFT JOIN customers c ON c.id = cd.customerid
            WHERE cd.isactive = true
            ORDER BY cd.docdate DESC, cd.id DESC
            LIMIT 500
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/orders/:id/receipts', async (req, res) => {
    const { docno, amount } = req.body || {};
    const orderId = Number(req.params.id);
    const receiptAmount = Number(amount);
    if (!Number.isInteger(orderId) || orderId <= 0 ||
        typeof docno !== 'string' || !docno.trim() ||
        !Number.isFinite(receiptAmount) || receiptAmount <= 0) {
        return res.status(400).json({ success: false, message: 'Thông tin phiếu thu không hợp lệ!' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const orderResult = await client.query(`
            SELECT so.id, so.customerid, so.totalamount, so.status,
                   COALESCE(returns.total_refund, 0) AS total_refund
            FROM sales_orders so
            LEFT JOIN LATERAL (
                SELECT SUM(totalrefund) AS total_refund
                FROM sales_returns
                WHERE orderid = so.id AND isactive = true
            ) returns ON true
            WHERE so.id = $1 AND so.isactive = true
            FOR UPDATE OF so
        `, [orderId]);
        if (orderResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng!' });
        }
        const order = orderResult.rows[0];
        if (order.status === 'Cancelled' || order.status === 'Returned' || Number(order.total_refund) > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Không thể thu tiền cho đơn đã hủy hoặc đã trả hàng!' });
        }
        const paidResult = await client.query(
            'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payment_receipts WHERE orderid = $1 AND isactive = true',
            [orderId]
        );
        const due = Math.max(0, Number(order.totalamount) - Number(order.total_refund) - Number(paidResult.rows[0].total_paid));
        if (receiptAmount > due) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: `Số tiền thu vượt quá công nợ còn lại (${due.toLocaleString('vi-VN')} VNĐ)!` });
        }

        await client.query(`
            INSERT INTO payment_receipts (docno, orderid, customerid, amount, createdby)
            VALUES ($1, $2, $3, $4, $5)
        `, [docno.trim(), orderId, order.customerid, receiptAmount, req.user.username]);

        const newTotalPaid = Number(paidResult.rows[0].total_paid) + receiptAmount;
        const fullyPaid = newTotalPaid >= Number(order.totalamount) - Number(order.total_refund);
        if (fullyPaid && order.status === 'Pending') {
            await client.query("UPDATE sales_orders SET status = 'Paid' WHERE id = $1", [orderId]);
        }
        await client.query('COMMIT');
        res.status(201).json({
            success: true,
            message: fullyPaid ? 'Đã thu đủ tiền, đơn hàng chuyển sang Paid.' : 'Đã ghi nhận phiếu thu một phần.',
            remainingDebt: Math.max(0, Number(order.totalamount) - Number(order.total_refund) - newTotalPaid)
        });
    } catch (err) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error('Lỗi rollback phiếu thu:', rollbackError);
            }
        }
        const status = err.code === '23505' ? 409 : 500;
        res.status(status).json({ success: false, message: err.code === '23505' ? 'Mã phiếu thu đã tồn tại!' : err.message });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/orders', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT orders.id, orders.docno, orders.orderdate, orders.totalamount,
                   CASE WHEN COALESCE(receipts.total_paid, 0) <= 0 THEN 0 ELSE orders.total_refund END AS total_refund,
                   orders.status, orders.customer_name, orders.customer_phone, so.createdby,
                   COALESCE(receipts.total_paid, 0) AS total_paid,
                   CASE
                       WHEN COALESCE(receipts.total_paid, 0) > 0
                            AND orders.total_refund >= orders.totalamount
                            AND orders.total_refund > 0 THEN 'Refunded'
                       WHEN COALESCE(receipts.total_paid, 0) <= 0 THEN 'Unpaid'
                       WHEN COALESCE(receipts.total_paid, 0) >= GREATEST(orders.totalamount - orders.total_refund, 0) THEN 'Paid'
                       ELSE 'Partially Paid'
                   END AS payment_status
            FROM v_sales_orders_list orders
            JOIN sales_orders so ON so.id = orders.id
            LEFT JOIN LATERAL (
                SELECT SUM(pr.amount) AS total_paid
                FROM payment_receipts pr
                WHERE pr.orderid = so.id AND pr.isactive = true
            ) receipts ON true
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// CẬP NHẬT API ĐỔI TRẠNG THÁI ĐƠN HÀNG (HOÀN KHO KHI HỦY)
app.put('/api/orders/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!/^\d+$/.test(id)) {
        return res.status(400).json({ success: false, message: 'Mã đơn hàng không hợp lệ!' });
    }
    const validStatuses = ['Paid', 'Delivered', 'Completed', 'Cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Trạng thái không hợp lệ!' });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const currentOrder = await client.query(`
            SELECT so.docno, so.status, so.totalamount, so.customerid
            FROM sales_orders so
            WHERE so.id = $1 AND so.isactive = true
            FOR UPDATE OF so
        `, [id]);
        if (currentOrder.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng!' });
        }
        const order = currentOrder.rows[0];
        const currentStatus = order.status;

        if (status === 'Completed' && currentStatus === 'Delivered') {
            const paymentCheck = await client.query(
                'SELECT COALESCE(SUM(amount), 0) AS total_paid FROM payment_receipts WHERE orderid = $1 AND isactive = true',
                [id]
            );
            const totalPaid = Number(paymentCheck.rows[0].total_paid);
            const totalAmount = Number(order.totalamount);

            if (totalPaid < totalAmount) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: `Đơn hàng chưa thanh toán đủ (${totalPaid.toLocaleString('vi-VN')} / ${totalAmount.toLocaleString('vi-VN')} VNĐ). Vui lòng lập phiếu thu trước khi hoàn tất!`
                });
            }
        }

        if (status === 'Cancelled') {
            const itemsResult = await client.query(`
                SELECT productid, warehouseid, quantity
                FROM sales_order_details
                WHERE orderid = $1 AND isactive = true
            `, [id]);

            for (const item of itemsResult.rows) {
                await client.query(
                    `INSERT INTO inventory (docno, productid, warehouseid, quantity, type, createdby)
                     VALUES ($1, $2, $3, $4, 2, $5)`,
                    [`RET-CAN-${order.docno}`, item.productid, item.warehouseid, item.quantity, req.user.username]
                );
            }
        }

        const result = await client.query(
            `UPDATE sales_orders SET status = $1 WHERE id = $2 RETURNING *`,
            [status, id]
        );

        await client.query('COMMIT');
        res.json({
            success: true,
            message: 'Cập nhật trạng thái và hoàn kho thành công!',
            order: result.rows[0]
        });
    } catch (err) {
        if (client) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error('Lỗi rollback cập nhật trạng thái:', rollbackError);
            }
        }
        console.error('Lỗi cập nhật trạng thái đơn hàng:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/orders/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT fn_get_order_detail($1) AS data', [req.params.id]);
        if (!result.rows[0].data) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng!' });
        }
        const metadata = await pool.query(`
            SELECT orders.status, orders.totalamount, orders.total_refund,
                   COALESCE((
                       SELECT SUM(pr.amount)
                       FROM payment_receipts pr
                       WHERE pr.orderid = so.id AND pr.isactive = true
                   ), 0) AS total_paid,
                   so.createdby, so.createdat
            FROM v_sales_orders_list orders
            JOIN sales_orders so ON so.id = orders.id
            WHERE orders.id = $1
        `,
            [req.params.id]
        );
        res.json({
            success: true,
            ...result.rows[0].data,
            order: {
                ...result.rows[0].data.order,
                status: metadata.rows[0].status,
                totalamount: metadata.rows[0].totalamount,
                total_refund: metadata.rows[0].total_refund,
                total_paid: metadata.rows[0].total_paid,
                createdby: metadata.rows[0].createdby,
                createdat: metadata.rows[0].createdat
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/returns', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT sr.id, sr.docno, sr.docdate, sr.orderid, sr.customerid,
                   CASE WHEN COALESCE(receipts.total_paid, 0) <= 0 THEN 0 ELSE sr.totalrefund END AS totalrefund,
                   sr.reason, sr.status, sr.createdby,
                   so.docno AS order_docno, c.code AS customer_code,
                   c.name AS customer_name,
                   CASE WHEN COALESCE(receipts.total_paid, 0) > 0 THEN cd.docno END AS disbursement_docno,
                   CASE WHEN COALESCE(receipts.total_paid, 0) > 0 THEN cd.amount END AS disbursement_amount,
                   CASE WHEN COALESCE(receipts.total_paid, 0) > 0 THEN cd.docdate END AS disbursement_date,
                   COALESCE(return_items.items, '[]'::jsonb) AS items
            FROM sales_returns sr
            LEFT JOIN sales_orders so ON so.id = sr.orderid
            LEFT JOIN customers c ON c.id = sr.customerid
            LEFT JOIN LATERAL (
                SELECT SUM(pr.amount) AS total_paid
                FROM payment_receipts pr
                WHERE pr.orderid = sr.orderid AND pr.isactive = true
            ) receipts ON true
            LEFT JOIN LATERAL (
                SELECT cd.docno, cd.amount, cd.docdate
                FROM cash_disbursements cd
                WHERE cd.returnid = sr.id AND cd.isactive = true
                ORDER BY cd.id DESC
                LIMIT 1
            ) cd ON true
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(jsonb_build_object(
                    'product_code', p.code,
                    'product_name', p.name,
                    'quantityreturned', srd.quantityreturned,
                    'unitprice', srd.unitprice
                ) ORDER BY p.name) AS items
                FROM sales_return_details srd
                JOIN products p ON p.id = srd.productid
                WHERE srd.returnid = sr.id AND srd.isactive = true
            ) return_items ON true
            WHERE sr.isactive = true
            ORDER BY sr.docdate DESC, sr.id DESC
            LIMIT 200
        `);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/returns/orders', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM v_eligible_return_orders');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. TẠO PHIẾU TRẢ HÀNG, CHỈ XUẤT PHIẾU CHI KHI ĐƠN ĐÃ THANH TOÁN (TOTAL_PAID > 0 HOẶC STATUS = 'Paid')
app.post('/api/returns', async (req, res) => {
    try {
        const { docno, orderid, customerid, reason, items, totalrefund, isCancelFlow } = req.body;
        
        // Kiểm tra số tiền thực tế khách đã thanh toán cho đơn hàng này
        const eligibleOrder = await pool.query(
            `SELECT so.docno AS order_docno, so.status,
                    COALESCE(receipts.total_paid, 0) AS total_paid
             FROM sales_orders so
             LEFT JOIN LATERAL (
                 SELECT SUM(pr.amount) AS total_paid
                 FROM payment_receipts pr
                 WHERE pr.orderid = so.id AND pr.isactive = true
             ) receipts ON true
             WHERE so.id = $1 AND so.isactive = true`,
            [orderid]
        );

        if (eligibleOrder.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng!' });
        }

        const currentOrderStatus = eligibleOrder.rows[0].status;
        const totalPaid = Number(eligibleOrder.rows[0].total_paid || 0);

        // ĐIỀU KIỆN CHUẨN: Chỉ tính số tiền hoàn trả (xuất phiếu chi) NẾU đơn đã thanh toán (totalPaid > 0 hoặc status là Paid)
        const isPaidOrder = totalPaid > 0 || currentOrderStatus === 'Paid';
        const refundAmount = isPaidOrder ? Number(totalrefund || 0) : 0;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // Gọi thủ tục sp_create_sales_return
            // Nếu refundAmount = 0 (chưa thanh toán), thủ tục sẽ không tạo cash_disbursements (không có phiếu chi)
            await client.query(
                'CALL sp_create_sales_return($1, $2, $3, $4, $5, $6)',
                [docno, orderid, customerid, reason, refundAmount, JSON.stringify(items)]
            );

            // Cập nhật người tạo
            await client.query('UPDATE sales_returns SET createdby = $1 WHERE docno = $2', [req.user.username, docno]);
            if (refundAmount > 0) {
                await client.query(`
                    UPDATE cash_disbursements
                    SET createdby = $1
                    WHERE returnid = (SELECT id FROM sales_returns WHERE docno = $2)
                `, [req.user.username, docno]);
            }

            // TỰ ĐỘNG NHẬP HOÀN KHO HÀNG (type = 2: Nhập kho trả lại)
            for (const item of items) {
                await client.query(
                    `INSERT INTO inventory (docno, productid, warehouseid, quantity, type, createdby)
                     VALUES ($1, $2, $3, $4, 2, $5)`,
                    [docno, item.productid, item.warehouseid, item.quantityreturned, req.user.username]
                );
            }

            // Chuyển trạng thái đơn sang 'Cancelled' nếu hủy đơn, hoặc giữ trạng thái hợp lệ
            const targetStatus = isCancelFlow ? 'Cancelled' : currentOrderStatus;
            await client.query(
                `UPDATE sales_orders SET status = $1, totalrefund = $2 WHERE id = $3`,
                [targetStatus, refundAmount, orderid]
            );

            await client.query('COMMIT');
        } catch (transactionError) {
            await client.query('ROLLBACK');
            throw transactionError;
        } finally {
            client.release();
        }

        res.json({
            success: true,
            message: refundAmount > 0 
                ? 'Đã tạo phiếu trả hàng, hoàn tiền (Phiếu chi) & nhập kho thành công!' 
                : 'Đã tạo phiếu trả hàng & nhập hoàn kho thành công (Không xuất phiếu chi do chưa thanh toán)!',
            totalrefund: refundAmount
        });
    } catch (err) {
        console.error('Lỗi xử lý trả hàng:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server Node.js đang chạy tại địa chỉ: http://localhost:${PORT}`);
});