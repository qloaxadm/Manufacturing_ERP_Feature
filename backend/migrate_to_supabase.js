const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres.oxdhhrgrkkqrfjydejyv:MARVEL7ace%404077090@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';

async function migrate() {
  console.log('========================================================');
  console.log(' Starting Database Migration to Supabase PostgreSQL');
  console.log('========================================================\n');

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Connecting to Supabase...');
    await client.connect();
    console.log(' Connected to Supabase PostgreSQL!\n');

    // 1. Create Core & AI Tables
    console.log('--- Step 1: Creating Tables and Indexes ---');

    const schemaStatements = [
      // 1. customer
      `CREATE TABLE IF NOT EXISTS customer (
        id SERIAL PRIMARY KEY,
        customer_name VARCHAR(255) NOT NULL
      );`,

      // 2. parts
      `CREATE TABLE IF NOT EXISTS parts (
        id SERIAL PRIMARY KEY,
        part_number VARCHAR(255) NOT NULL,
        part_description TEXT NOT NULL,
        qty FLOAT NOT NULL DEFAULT 0,
        customer_id INT NOT NULL DEFAULT 0,
        revision_date VARCHAR(50) DEFAULT NULL,
        customer_part_id INT NOT NULL DEFAULT 0,
        revision_no VARCHAR(255) DEFAULT NULL,
        diagram VARCHAR(50) DEFAULT NULL,
        model VARCHAR(50) DEFAULT NULL,
        part_family VARCHAR(200) DEFAULT '',
        created_id INT NOT NULL DEFAULT 0,
        date VARCHAR(255) DEFAULT '',
        time VARCHAR(255) DEFAULT '',
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        deleted INT DEFAULT NULL,
        revision_remark VARCHAR(100) DEFAULT NULL,
        hsn_code VARCHAR(20) DEFAULT NULL,
        uom VARCHAR(20) DEFAULT NULL,
        safety_stock VARCHAR(20) DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_parts_part_number ON parts (part_number);`,

      // 3. userinfo
      `CREATE TABLE IF NOT EXISTS userinfo (
        id SERIAL PRIMARY KEY,
        user_email TEXT,
        type VARCHAR(30) NOT NULL,
        user_role TEXT,
        user_name VARCHAR(255) DEFAULT NULL,
        user_password TEXT,
        date TEXT,
        time TEXT,
        timestamp TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        deleted TEXT,
        drawing_download VARCHAR(20) DEFAULT 'yes',
        drawing_upload VARCHAR(20) DEFAULT 'yes'
      );
      CREATE INDEX IF NOT EXISTS idx_userinfo_type ON userinfo (type);`,

      // 4. packing
      `CREATE TABLE IF NOT EXISTS packing (
        id SERIAL PRIMARY KEY,
        barcode VARCHAR(50) NOT NULL,
        part_id INT NOT NULL,
        part_qty INT NOT NULL,
        packing_details TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        packing_name VARCHAR(50) DEFAULT '',
        created_by INT NOT NULL,
        created_time VARCHAR(11) NOT NULL,
        created_date VARCHAR(11) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_packing_barcode ON packing (barcode);
      CREATE INDEX IF NOT EXISTS idx_packing_status ON packing (status);
      CREATE INDEX IF NOT EXISTS idx_packing_part_id ON packing (part_id);`,

      // 5. box
      `CREATE TABLE IF NOT EXISTS box (
        id SERIAL PRIMARY KEY,
        barcode VARCHAR(50) NOT NULL,
        box_name VARCHAR(20) NOT NULL,
        box_size VARCHAR(20) DEFAULT NULL,
        customer_id INT DEFAULT NULL,
        created_by INT NOT NULL,
        created_date VARCHAR(50) NOT NULL,
        created_time VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        lock_status VARCHAR(10) NOT NULL DEFAULT 'no'
      );
      CREATE INDEX IF NOT EXISTS idx_box_barcode ON box (barcode);
      CREATE INDEX IF NOT EXISTS idx_box_status ON box (status);`,

      // 6. box_packing
      `CREATE TABLE IF NOT EXISTS box_packing (
        id SERIAL PRIMARY KEY,
        box_id INT NOT NULL,
        pack_id INT NOT NULL,
        part_id INT NOT NULL,
        part_qty INT NOT NULL,
        created_by INT NOT NULL,
        created_date VARCHAR(20) NOT NULL,
        created_time VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_box_packing_box_id ON box_packing (box_id);
      CREATE INDEX IF NOT EXISTS idx_box_packing_status ON box_packing (status);`,

      // 7. invoice
      `CREATE TABLE IF NOT EXISTS invoice (
        id SERIAL PRIMARY KEY,
        barcode VARCHAR(50) NOT NULL,
        invoice_number VARCHAR(20) NOT NULL,
        created_by INT NOT NULL,
        created_date VARCHAR(50) NOT NULL,
        created_time VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        lock_status VARCHAR(20) NOT NULL DEFAULT 'no',
        qty FLOAT NOT NULL,
        part_id INT NOT NULL,
        status_new VARCHAR(20) NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_barcode ON invoice (barcode);
      CREATE INDEX IF NOT EXISTS idx_invoice_number ON invoice (invoice_number);
      CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoice (status);`,

      // 8. invoice_box
      `CREATE TABLE IF NOT EXISTS invoice_box (
        id SERIAL PRIMARY KEY,
        box_id INT NOT NULL,
        invoice_id INT NOT NULL,
        created_by INT NOT NULL,
        created_date VARCHAR(20) NOT NULL,
        created_time VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_box_box_id ON invoice_box (box_id);
      CREATE INDEX IF NOT EXISTS idx_invoice_box_invoice_id ON invoice_box (invoice_id);`,

      // 9. invoice_match
      `CREATE TABLE IF NOT EXISTS invoice_match (
        id SERIAL PRIMARY KEY,
        barcode VARCHAR(50) DEFAULT NULL,
        invoice_number VARCHAR(20) NOT NULL,
        created_by INT NOT NULL,
        created_date VARCHAR(50) NOT NULL,
        created_time VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        total_stock FLOAT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_match_barcode ON invoice_match (barcode);
      CREATE INDEX IF NOT EXISTS idx_invoice_match_invoice_number ON invoice_match (invoice_number);`,

      // 10. invoice_box_match
      `CREATE TABLE IF NOT EXISTS invoice_box_match (
        id SERIAL PRIMARY KEY,
        box_id INT NOT NULL,
        invoice_id INT NOT NULL,
        created_by INT NOT NULL,
        created_date VARCHAR(20) NOT NULL,
        created_time VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_box_match_box_id ON invoice_box_match (box_id);`,

      // 11. gate_risk_analysis
      `CREATE TABLE IF NOT EXISTS gate_risk_analysis (
        id SERIAL PRIMARY KEY,
        match_id INT NULL,
        invoice_barcode VARCHAR(50) NOT NULL,
        invoice_number VARCHAR(50) NULL,
        customer_id INT NULL,
        customer_name VARCHAR(255) NULL,
        part_id INT NULL,
        part_number VARCHAR(255) NULL,
        invoice_qty FLOAT DEFAULT 0,
        risk_score INT DEFAULT 0,
        risk_level VARCHAR(20) DEFAULT 'LOW',
        risk_factors TEXT NULL,
        reasons TEXT NULL,
        recommendation TEXT NULL,
        metrics TEXT NULL,
        model_version VARCHAR(50) DEFAULT 'v1.0-explainable-heuristics',
        review_status VARCHAR(30) DEFAULT 'not_required',
        reviewed_by INT NULL,
        reviewed_by_name VARCHAR(255) NULL,
        review_timestamp TIMESTAMP NULL,
        review_note TEXT NULL,
        review_decision VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_gate_risk_analysis_match_id ON gate_risk_analysis (match_id);
      CREATE INDEX IF NOT EXISTS idx_gate_risk_analysis_invoice_barcode ON gate_risk_analysis (invoice_barcode);
      CREATE INDEX IF NOT EXISTS idx_gate_risk_analysis_risk_level ON gate_risk_analysis (risk_level);
      CREATE INDEX IF NOT EXISTS idx_gate_risk_analysis_review_status ON gate_risk_analysis (review_status);`,

      // 12. gate_scan_log
      `CREATE TABLE IF NOT EXISTS gate_scan_log (
        id SERIAL PRIMARY KEY,
        match_id INT NULL,
        invoice_barcode VARCHAR(50) NULL,
        scanned_barcode VARCHAR(50) NOT NULL,
        scan_type VARCHAR(20) NOT NULL,
        is_valid BOOLEAN DEFAULT TRUE,
        failure_reason VARCHAR(255) NULL,
        user_id INT NULL,
        user_name VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_gate_scan_log_match_id ON gate_scan_log (match_id);
      CREATE INDEX IF NOT EXISTS idx_gate_scan_log_invoice_barcode ON gate_scan_log (invoice_barcode);`,

      // 13. gate_risk_config
      `CREATE TABLE IF NOT EXISTS gate_risk_config (
        id SERIAL PRIMARY KEY,
        config_key VARCHAR(100) NOT NULL UNIQUE,
        config_value TEXT NOT NULL,
        description VARCHAR(255) NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );`,

      // 14. daily_security_briefing
      `CREATE TABLE IF NOT EXISTS daily_security_briefing (
        id SERIAL PRIMARY KEY,
        briefing_date VARCHAR(20) NOT NULL UNIQUE,
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        total_events INT DEFAULT 0,
        normal_count INT DEFAULT 0,
        high_priority_count INT DEFAULT 0,
        medium_priority_count INT DEFAULT 0,
        low_priority_count INT DEFAULT 0,
        pending_reviews_count INT DEFAULT 0,
        executive_summary TEXT NULL,
        events TEXT NULL,
        status VARCHAR(30) DEFAULT 'generated',
        generated_by VARCHAR(50) DEFAULT 'system',
        engine_version VARCHAR(50) DEFAULT 'v1.0-evidence-consolidator',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_daily_security_briefing_date ON daily_security_briefing (briefing_date);`,

      // 15. erp_notification
      `CREATE TABLE IF NOT EXISTS erp_notification (
        id SERIAL PRIMARY KEY,
        recipient_user_id INT NULL,
        recipient_role VARCHAR(50) DEFAULT 'ALL',
        type VARCHAR(60) NOT NULL,
        priority VARCHAR(20) DEFAULT 'INFO',
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        reason TEXT NULL,
        module VARCHAR(100) NULL,
        actor_name VARCHAR(255) NULL,
        actor_id INT NULL,
        actor_role VARCHAR(50) NULL,
        actor_email VARCHAR(255) NULL,
        entity_type VARCHAR(50) NULL,
        entity_id VARCHAR(100) NULL,
        action_url VARCHAR(255) NULL,
        metadata TEXT NULL,
        dedup_key VARCHAR(180) NULL,
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMP NULL,
        lifecycle_status VARCHAR(30) DEFAULT 'OPEN',
        resolved_by_name VARCHAR(255) NULL,
        resolved_at TIMESTAMP NULL,
        resolution_note TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NULL
      );
      CREATE INDEX IF NOT EXISTS idx_erp_notif_recipient ON erp_notification (recipient_role, is_read);
      CREATE INDEX IF NOT EXISTS idx_erp_notif_dedup ON erp_notification (dedup_key);
      CREATE INDEX IF NOT EXISTS idx_erp_notif_created ON erp_notification (created_at);`,

      // 16. part_history
      `CREATE TABLE IF NOT EXISTS part_history (
        id SERIAL PRIMARY KEY,
        part_id INT NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        quantity_change FLOAT NOT NULL DEFAULT 0,
        previous_qty FLOAT NOT NULL DEFAULT 0,
        new_qty FLOAT NOT NULL DEFAULT 0,
        supplier_name VARCHAR(255) NULL,
        supplier_contact VARCHAR(255) NULL,
        supplier_invoice_no VARCHAR(100) NULL,
        supplier_notes TEXT NULL,
        created_by_user_id INT NULL,
        created_by_user_name VARCHAR(255) NULL,
        created_by_user_role VARCHAR(50) NULL,
        entry_date VARCHAR(30) NOT NULL,
        entry_time VARCHAR(30) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        notes TEXT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_part_history_part_id ON part_history (part_id);
      CREATE INDEX IF NOT EXISTS idx_part_history_event_type ON part_history (event_type);
      CREATE INDEX IF NOT EXISTS idx_part_history_entry_date ON part_history (entry_date);`,

      // 17. audit_activity_log
      `CREATE TABLE IF NOT EXISTS audit_activity_log (
        id SERIAL PRIMARY KEY,
        user_id INT NULL,
        user_name VARCHAR(255) NULL,
        user_role VARCHAR(50) NULL,
        user_email VARCHAR(255) NULL,
        action_type VARCHAR(20) NOT NULL,
        action_title VARCHAR(255) NOT NULL,
        module VARCHAR(100) NOT NULL,
        entity_type VARCHAR(100) NULL,
        entity_id VARCHAR(100) NULL,
        details TEXT NULL,
        metadata TEXT NULL,
        ip_address VARCHAR(50) NULL,
        created_date VARCHAR(30) NOT NULL,
        created_time VARCHAR(30) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_audit_activity_log_user_id ON audit_activity_log (user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_activity_log_action_type ON audit_activity_log (action_type);
      CREATE INDEX IF NOT EXISTS idx_audit_activity_log_module ON audit_activity_log (module);
      CREATE INDEX IF NOT EXISTS idx_audit_activity_log_created_date ON audit_activity_log (created_date);`
    ];

    for (const stmt of schemaStatements) {
      await client.query(stmt);
    }
    console.log(' All 17 tables and indexes created successfully!\n');

    // 2. Import Data from Dump20260919.sql
    console.log('--- Step 2: Importing Data from Dump20260919.sql ---');
    const sqlPath = path.resolve(__dirname, '../Dump20260919.sql');
    const dumpContent = fs.readFileSync(sqlPath, 'utf8');

    const insertRegex = /INSERT INTO `(\w+)` VALUES\s*([\s\S]*?);/g;
    let match;

    const coreTables = ['customer', 'userinfo', 'parts', 'packing', 'box', 'box_packing', 'invoice', 'invoice_box', 'invoice_match', 'invoice_box_match'];

    // Map table name to the insert statements
    const tableInserts = {};
    while ((match = insertRegex.exec(dumpContent)) !== null) {
      const tableName = match[1];
      const values = match[2];
      tableInserts[tableName] = values;
    }

    // Insert in foreign-key safe order: customer -> userinfo -> parts -> packing -> box -> box_packing -> invoice -> invoice_box -> invoice_match -> invoice_box_match
    for (const tableName of coreTables) {
      if (!tableInserts[tableName]) {
        console.log(`- Table ${tableName}: No INSERT data found in dump.`);
        continue;
      }

      // Check if table already has rows
      const countRes = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
      const rowCount = parseInt(countRes.rows[0].count, 10);

      if (rowCount > 0) {
        console.log(`- Table ${tableName}: Already contains ${rowCount} rows (skipping insert).`);
      } else {
        const insertQuery = `INSERT INTO ${tableName} VALUES ${tableInserts[tableName]};`;
        console.log(`- Table ${tableName}: Inserting data...`);
        await client.query(insertQuery);
        const newCountRes = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
        console.log(`  -> Imported ${newCountRes.rows[0].count} rows into ${tableName}.`);
      }
    }

    // 3. Reset Sequences
    console.log('\n--- Step 3: Synchronizing Sequence Counters ---');
    for (const tableName of coreTables) {
      const seqQuery = `SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), COALESCE((SELECT MAX(id) FROM ${tableName}), 1));`;
      await client.query(seqQuery);
      console.log(`- Sequence for ${tableName}.id synchronized.`);
    }

    // 4. Seed Default Configurations for Gate Risk AI
    console.log('\n--- Step 4: Seeding Gate Risk AI Configuration ---');
    const defaultConfigs = [
      ['WEIGHT_QUANTITY', '28', 'Maximum weight for order quantity deviation'],
      ['WEIGHT_TIME', '20', 'Maximum weight for off-hours dispatch'],
      ['WEIGHT_WORKFLOW_BYPASS', '22', 'Maximum weight for packing-to-gate bypass'],
      ['WEIGHT_FAILED_SCANS', '25', 'Maximum weight for failed scan patterns'],
      ['WEIGHT_CUSTOMER_PATTERN', '15', 'Weight for customer pattern / new product deviations'],
      ['WEIGHT_USER_VELOCITY', '12', 'Weight for unusual operator velocity'],
      ['THRESHOLD_LOW_MAX', '30', 'Max score for LOW risk level'],
      ['THRESHOLD_MEDIUM_MAX', '70', 'Max score for MEDIUM risk level'],
      ['OFF_HOURS_START', '20', 'Hour when off-hours begins (24h)'],
      ['OFF_HOURS_END', '6', 'Hour when off-hours ends (24h)'],
      ['REQUIRE_APPROVAL_HIGH_RISK', 'true', 'Require manual approval for HIGH risk dispatches']
    ];

    for (const [key, val, desc] of defaultConfigs) {
      await client.query(`
        INSERT INTO gate_risk_config (config_key, config_value, description)
        VALUES ($1, $2, $3)
        ON CONFLICT (config_key) DO NOTHING;
      `, [key, val, desc]);
    }
    console.log(' Default gate risk configs verified/seeded.');

    // 5. Verification & Summary
    console.log('\n========================================================');
    console.log(' Migration Summary & Verification');
    console.log('========================================================');

    const allTables = [
      'customer', 'parts', 'userinfo', 'packing', 'box', 'box_packing',
      'invoice', 'invoice_box', 'invoice_match', 'invoice_box_match',
      'gate_risk_analysis', 'gate_scan_log', 'gate_risk_config',
      'daily_security_briefing', 'erp_notification', 'part_history',
      'audit_activity_log'
    ];

    for (const table of allTables) {
      const res = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
      console.log(`  Table: ${table.padEnd(25)} Rows: ${res.rows[0].count}`);
    }

    console.log('========================================================');
    console.log(' Database Migration Successfully Completed!');
    console.log('========================================================\n');

  } catch (err) {
    console.error('\n Migration Error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();

