const { SocksClient } = require("socks");

const proxy = {
  host: "",
  port: 9091,
  type: 5,
  userId: "",
  password: "",
};

const destination = {
  host: "example.com",
  port: 80,
};

// 🕒 Simple readable time
const now = () => new Date().toLocaleTimeString();

(async () => {
  const { socket } = await SocksClient.createConnection({
    proxy,
    command: "connect",
    destination,
  });

  console.log(`[${now()}] ✅ SOCKS5 tunnel to example.com:80 established.`);

  const sendHttpRequest = () => {
    const req = `GET / HTTP/1.1\r\nHost: example.com\r\nConnection: keep-alive\r\n\r\n`;
    socket.write(req);
    console.log(`[${now()}] ➡️ Sent HTTP GET request`);
  };

  socket.on("data", () => {
    console.log(`[${now()}] ⬅️ Received data`);
  });

  socket.on("close", () => {
    console.log(`[${now()}] 🔌 Socket closed`);
    process.exit(0);
  });

  socket.on("error", (err) => {
    console.error(`[${now()}] ❌ Socket error:`, err.message);
    process.exit(1);
  });

  sendHttpRequest();

  setInterval(() => {
    sendHttpRequest();
  }, 5000);
})();
