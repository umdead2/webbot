const socket = io();

const input = document.getElementById('cmdInput');
const button = document.getElementById('sendBtn');

button.onclick = () => {
    const command = input.value;
    if (command) {
        // Send the command to the Node.js backend
        socket.emit('command_from_web', command);
        input.value = '';
        console.log('Sent to bot:', command);
    }
};

// Optional: Allow pressing "Enter" to send
input.onkeydown = (e) => {
    if (e.key === 'Enter') button.click();
};