const { SocksClient } = require("socks");
const tls = require("tls");

const proxy = {
  host: "47.128.249.210",
  port: 9091,
  type: 5,
  userId: "algo_session_32331_test",
  password: "1g91WQkY2SmO6v50Ul3",
  // userId: "admin",
  // password: "admin",
};

const destinations = [
  { host: "google.com", port: 80, type: "http" },
  { host: "example.com", port: 80, type: "http" },
  // {
  //   host: "fstream.binance.com", // chỉ hostname thôi
  //   port: 443,
  //   type: "ws",
  //   path: "/ws/solusdt@depth20@100ms", // path để handshake
  // },
];

const now = () => new Date().toLocaleTimeString();

(async () => {
  for (const destination of destinations) {
    console.log(
      `\n=== Connecting to ${destination.host}:${destination.port} (${destination.type}) ===`
    );

    const { socket } = await SocksClient.createConnection({
      proxy,
      command: "connect",
      destination: {
        host: destination.host,
        port: destination.port,
      },
    });

    console.log(
      `[${now()}] ✅ SOCKS5 tunnel to ${destination.host}:${
        destination.port
      } established.`
    );

    if (destination.type === "http") {
      const sendHttpRequest = () => {
        const req = `GET / HTTP/1.1\r\nHost: ${destination.host}\r\nConnection: keep-alive\r\n\r\n`;
        socket.write(req);
        console.log(`[${now()}] ➡️ Sent HTTP GET request`);
      };

      socket.on("data", () => {
        console.log(`[${now()}] ⬅️ Received data from ${destination.host}`);
      });

      socket.on("close", () => {
        console.log(`[${now()}] 🔌 Socket to ${destination.host} closed`);
        process.exit(0);
      });

      socket.on("error", (err) => {
        console.error(
          `[${now()}] ❌ Socket error to ${destination.host}:`,
          err.message
        );
        process.exit(1);
      });

      sendHttpRequest();
      setInterval(sendHttpRequest, 5000);
    } else if (destination.type === "ws") {
      const secureSocket = tls.connect(
        {
          socket,
          servername: destination.host, // SNI
        },
        () => {
          console.log(
            `[${now()}] 🔐 TLS connection established to ${destination.host}`
          );

          const handshake =
            `GET ${destination.path} HTTP/1.1\r\n` +
            `Host: ${destination.host}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`;

          secureSocket.write(handshake);
          console.log(`[${now()}] 🤝 Sent WebSocket handshake`);
        }
      );

      secureSocket.on("data", (data) => {
        console.log(`[${now()}] ⬅️ Received data from ${destination.host}`);
      });

      secureSocket.on("close", () => {
        console.log(`[${now()}] 🔌 WS connection closed`);
        process.exit(0);
      });

      secureSocket.on("error", (err) => {
        console.error(`[${now()}] ❌ WS error:`, err.message);
        process.exit(1);
      });
    }
  }
})();
