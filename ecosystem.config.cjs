module.exports = {
  apps: [
    {
      name: "energy-certificate-requests",
      script: "src/server.js",
      node_args: "--no-warnings",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "250M",
      env: {
        NODE_ENV: "production",
        PORT: 9348
      }
    }
  ]
};
