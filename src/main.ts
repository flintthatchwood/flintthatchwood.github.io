import { Viewer } from './viewer.js';

declare global {
    interface Window {
        arkApp?: Viewer;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const error = (error: unknown) => {
        const loading = document.getElementById('loading');
        if (loading) loading.textContent = error instanceof Error ? error.message : String(error);
    };
    try {
        const viewer = new Viewer();
        window.arkApp = viewer;
        void viewer.start().catch(error);
    } catch (failure) {
        error(failure);
    }
});
