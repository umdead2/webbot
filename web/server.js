const socket = io();
    const consoleDiv = document.getElementById('console');
    const statusText = document.getElementById('status-text');
    const statusDot = document.getElementById('status-dot');

    function launchBot() {
        const data = {
            host: document.getElementById('host').value,
            username: document.getElementById('user').value,
            password: document.getElementById('pass').value
        };
        
        if (!data.username || !data.password) {
            alert("Please enter both a username and password.");
            return;
        }

        // Clear console for new session
        consoleDiv.innerHTML = '<div>[SYSTEM] Starting bot connection...</div>';
        socket.emit('start_bot', data);
    }

    function sendCmd() {
        const cmdInput = document.getElementById('cmd');
        if (cmdInput.value.trim() !== "") {
            socket.emit('command_from_web', cmdInput.value);
            cmdInput.value = '';
        }
    }

    document.getElementById('btn-disconnect').addEventListener('click', () => {
        socket.emit('stop_bot');
    });

    // Handle incoming chat
    socket.on('bot_chat', (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        consoleDiv.appendChild(line);
        consoleDiv.scrollTop = consoleDiv.scrollHeight;
    });

    // Handle status updates
    socket.on('bot_status', (status) => {
        statusText.innerText = status;
        
        if (status.includes("Active") || status.includes("In Limbo")) {
            statusDot.className = "status-dot online";
        } else if (status === "Kicked" || status === "Error") {
            statusDot.className = "status-dot offline";
        } else {
            statusDot.className = "status-dot";
        }
    });

    // Allow Enter key to send
    document.getElementById('cmd').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendCmd();
    });