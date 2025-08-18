const net = require("net");

const destinations = [
  { host: "google.com", port: 80 },
  { host: "example.com", port: 80 },
  { host: "facebook.com", port: 80 },
];

const proxy = {
  host: "15.152.1.115",
  port: 9091,
  type: 5,
  userId: "algo_session_32331_test",
  password: "65BL0218HwiCRTouV",
};

const now = () => new Date().toLocaleTimeString();

// Tạo 1 TCP connection tới HTTP proxy
const socket = net.connect(proxy.port, proxy.host, () => {
  console.log(
    `[${now()}] ✅ Connected to HTTP proxy ${proxy.host}:${proxy.port}`
  );

  destinations.forEach((dest, i) => {
    setTimeout(() => {
      const req =
        `GET http://${dest.host}/ HTTP/1.1\r\n` +
        `Host: ${dest.host}\r\n` +
        `Connection: keep-alive\r\n\r\n`;
      socket.write(req);
      console.log(`[${now()}] ➡️ Sent HTTP GET to ${dest.host}`);
    }, i * 2000);
  });
});

socket.on("data", (data) => {
  console.log(`[${now()}] ⬅️ Received data:\n${data.toString()}`);
});

socket.on("end", () => {
  console.log(`[${now()}] 🔌 Connection closed`);
});
