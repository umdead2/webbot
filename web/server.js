const socket = io();
const consoleDiv = document.getElementById('console');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');

let allPlayers = []; // Holds players for the search filter

// --- 1. Bot Connection & Status ---
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

    localStorage.setItem('bot_host', data.host);
    localStorage.setItem('bot_user', data.username);
    localStorage.setItem('bot_pass', data.password);
    
    consoleDiv.innerHTML = '<div>[SYSTEM] Starting bot connection...</div>';
    socket.emit('start_bot', data);
}

document.getElementById('btn-disconnect').addEventListener('click', () => {
    socket.emit('stop_bot');
});

socket.on('bot_status', (status) => {
    statusText.innerText = status;
    statusDot.className = "status-dot " + 
        (status.includes("Active") || status.includes("In Limbo") ? "online" : "offline");
});

// --- 2. Chat & Commands ---
socket.on('bot_chat', (msg) => {
    const line = document.createElement('div');
    line.textContent = msg;
    consoleDiv.appendChild(line);
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
});

function sendCmd() {
    const cmdInput = document.getElementById('cmd');
    if (cmdInput.value.trim() !== "") {
        socket.emit('command_from_web', cmdInput.value);
        cmdInput.value = '';
    }
}

// --- 3. Player List & Custom Search ---
socket.on('player_list', (players) => {
    allPlayers = players; // Store for search
    document.getElementById('player-count').innerText = players.length;
    
    // Update the visual grid list
    const listDiv = document.getElementById('player-list');
    listDiv.innerHTML = players.map(name => `<div>${name}</div>`).join('');
});

const searchInput = document.getElementById('player-search');
const resultsDiv = document.getElementById('search-results');

searchInput.addEventListener('input', () => {
    const val = searchInput.value.toLowerCase();
    resultsDiv.innerHTML = '';
    
    if (!val) {
        resultsDiv.style.display = 'none';
        return;
    }

    const matches = allPlayers.filter(p => p.toLowerCase().includes(val));

    if (matches.length > 0) {
        resultsDiv.style.display = 'block';
        matches.forEach(name => {
            const div = document.createElement('div');
            div.classList.add('dropdown-item');
            div.textContent = name;
            div.onclick = () => {
                searchInput.value = name;
                resultsDiv.style.display = 'none';
            };
            resultsDiv.appendChild(div);
        });
    } else {
        resultsDiv.style.display = 'none';
    }
});

function sendToSelected() {
    // 1. Grab every element by its ID
    const searchInput = document.getElementById('player-search');
    const cmdSelect = document.getElementById('commands');
    const timeInput = document.getElementById('time');
    const reasonInput = document.getElementById('reason');
    const offenseInput = document.getElementById('offense');

    // 2. Extract the actual text values
    const player = searchInput.value.trim();
    const command = cmdSelect.value; // e.g., "/ipmute "
    const time = timeInput.value.trim();
    const reason = reasonInput.value.trim();
    const offense = offenseInput.value.trim();

    // 3. Debugging: This will show in your browser console
    console.log("Attempting to send:", command, player, time, reason, offense);

    // 4. Validation: Only send if we at least have a player name
    if (player !== "") {
        // Build the string: "/ipmute Player 7d Spam #1"
        const finalCmd = `${command}${player} ${time} ${reason} ${offense}`;
        
        socket.emit('command_from_web', finalCmd);

        // 5. Clean up the boxes
        searchInput.value = '';
        timeInput.value = '';
        reasonInput.value = '';
        offenseInput.value = '';
        
        // Hide the dropdown if it's still open
        document.getElementById('search-results').style.display = 'none';
    } else {
        alert("You must select a player first!");
    }
}

// Close dropdown if clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) resultsDiv.style.display = 'none';
});

// --- 4. Initialization ---
window.onload = () => {
    const fields = ['host', 'user', 'pass'];
    fields.forEach(field => {
        const input = document.getElementById(field);
        const saved = localStorage.getItem('bot_' + field);
        if (saved) input.value = saved;
        
        input.addEventListener('input', () => {
            localStorage.setItem('bot_' + field, input.value);
        });
    });
};

document.getElementById('cmd').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendCmd();
});