const { Client } = require('pg');

async function testConn() {
  const client = new Client({
    connectionString: 'postgresql://postgres.oxdhhrgrkkqrfjydejyv:MARVEL7ace%404077090@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Successfully connected to Supabase PostgreSQL!');
    const res = await client.query('SELECT NOW(), version();');
    console.log('Query result:', res.rows[0]);
    await client.end();
  } catch (err) {
    console.error('Connection failed:', err.message);
  }
}

testConn();
