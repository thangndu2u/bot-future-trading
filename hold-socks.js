const { SocksClient } = require("socks");

const proxy = {
  host: "",
  port: 9091,
  type: 5,
  userId: "",
  password: "",
};

const destination = {
  host: "google.com",
  port: 443,
};

(async () => {
  try {
    console.log("🚀 Connecting via SOCKS5 proxy...");

    const { socket } = await SocksClient.createConnection({
      proxy,
      command: "connect",
      destination,
    });

    console.log(
      "✅ SOCKS5 connection established. Holding open... (Press Ctrl + C to exit)"
    );

    // Keep connection alive
    socket.on("close", () => {
      console.log("🔌 Socket closed");
      process.exit(0);
    });

    socket.on("error", (err) => {
      console.error("❌ Socket error:", err.message);
      process.exit(1);
    });

    // Ping every 30s to avoid idle timeout (optional)
    setInterval(() => {
      socket.write("PING");
      console.log("💓 Sent PING to keep socket alive");
    }, 30000);
  } catch (err) {
    console.error("❌ Failed to connect via SOCKS5:", err.message);
  }
})();
