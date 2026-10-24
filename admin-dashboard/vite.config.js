import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '');
    const apiTarget = env.API_URL || 'http://localhost:3001';

    return {
        plugins: [react()],
        define: {
            __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
        },
        server: {
            port: 5173,
            proxy: {
                '/api': {
                    target: apiTarget,
                    changeOrigin: true,
                },
                '/webhook': {
                    target: apiTarget,
                    changeOrigin: true,
                },
            },
        },
    };
});
