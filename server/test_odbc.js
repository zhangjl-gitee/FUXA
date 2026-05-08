const odbc = require('odbc');

async function testConnection() {
    //const connectionString = 'DSN=TestSQL;'; // 修改为您的DSN名
	const connectionString = 'Driver={SQL Server};Server=localhost;Database=ChanRaoJi;Uid=sa;Pwd=123456;';
    console.log('尝试连接到 DSN: ', connectionString);

    try {
        const connection = await odbc.connect(connectionString);
        console.log('✅ ODBC 连接成功！');
        // 可选：执行一个简单查询
        const result = await connection.query('SELECT @@version as version');
        console.log('✅ 查询成功，SQL Server版本信息：');
        console.log(result);
        await connection.close();
    } catch (error) {
        console.error('❌ ODBC 连接失败，详细错误：');
        console.error(error.message);
        console.error(error.stack); // 打印堆栈跟踪，对于诊断至关重要
    }
}

testConnection();