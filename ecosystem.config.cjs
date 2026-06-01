module.exports = {
  apps: [
    {
      name: 'db-query-tool',
      script: './server.js',
      cwd: '/www/wwwroot/db-query-tool',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        APP_DB_PATH: '/www/data/db-query-tool/app.sqlite',
      },
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_memory_restart: '512M',
      error_file: '/www/wwwlogs/db-query-tool-error.log',
      out_file: '/www/wwwlogs/db-query-tool-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
}
