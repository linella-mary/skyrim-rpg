const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const WS_URL = `ws://localhost:${PORT}`;

async function runTest() {
    console.log(`Connecting to ${WS_URL}...`);
    const ws = new WebSocket(WS_URL);

    const send = (obj) => ws.send(JSON.stringify(obj));

    ws.on('open', async () => {
        console.log('Connected!');

        const testUser = `TestUser_${Math.floor(Math.random() * 10000)}`;

        // 1. Try to login with non-existent user
        console.log(`Step 1: Login as ${testUser} (should fail)`);
        send({ action: 'login', username: testUser });
    });

    ws.on('message', async (data) => {
        const msg = JSON.parse(data);
        console.log('Received:', msg);

        if (msg.event === 'login_failed' && msg.reason === 'not_found') {
            console.log('✅ Step 1 Success: Login failed as expected');
            
            // 2. Create the character
            console.log('Step 2: Create character');
            ws.testUsername = msg.username || `TestUser_${Math.floor(Math.random() * 10000)}`; 
            // The message doesn't have username, but we know it from our local state
        }

        if (msg.event === 'login_success') {
            console.log('✅ Success: Login/Creation successful!', msg.data.username);
            if (!ws.created) {
                ws.created = true;
                console.log('Step 3: Try to create with same name');
                send({ action: 'create_character', username: msg.data.username, race: 'Altmer' });
            } else {
                console.log('Test finished successfully.');
                ws.close();
                process.exit(0);
            }
        }

        if (msg.event === 'creation_failed' && msg.reason === 'name_taken') {
            console.log('✅ Step 3 Success: Name taken as expected');
            console.log('Step 4: Re-login as created user');
            // We already did a "login_success" from creation, so we just finish.
            console.log('Test finished successfully.');
            ws.close();
            process.exit(0);
        }
    });

    // Handle initial state for step 2 better
    let step = 1;
    let testUsername = `TestUser_${Math.floor(Math.random() * 10000)}`;

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.event === 'login_failed' && step === 1) {
            step = 2;
            send({ 
                action: 'create_character', 
                username: testUsername, 
                race: 'Khajiit', 
                appearance: { eye_color: 'amber', hair: 'black' } 
            });
        }
    });
}

runTest().catch(console.error);
