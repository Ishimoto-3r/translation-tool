/**
 * UI Utilities for Translation Tools
 * - Toast Notifications
 * - Inline Error Handling
 */

const UI = {
    // トースト通知を表示
    showToast: (message, type = 'info') => {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span>${message}</span>
            <button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;font-size:1.2em;margin-left:10px;">&times;</button>
        `;

        container.appendChild(toast);

        // 3秒後に自動で消える
        setTimeout(() => {
            toast.style.animation = 'fadeOut 0.5s ease-out forwards';
            setTimeout(() => toast.remove(), 500);
        }, 5000);
    },

    // 成功トーストのショートカット
    showSuccess: (message) => UI.showToast(message, 'success'),

    // エラートーストのショートカット
    showErrorToast: (message) => UI.showToast(message, 'error'),

    // インラインエラー表示（入力欄の下などに出す）
    showError: (elementId, message) => {
        const inputElement = document.getElementById(elementId);
        if (!inputElement) return;

        // 既存のエラーメッセージがあれば削除
        UI.clearError(elementId);

        const errorDiv = document.createElement('div');
        errorDiv.className = 'text-error';
        errorDiv.id = `${elementId}-error`;
        errorDiv.innerText = message;

        inputElement.classList.add('border-error'); // 赤枠などを出したい場合
        inputElement.parentNode.appendChild(errorDiv);

        // 入力時にエラーを消すイベントリスナーを一回だけ追加
        const clearHandler = () => {
            UI.clearError(elementId);
            inputElement.removeEventListener('input', clearHandler);
        };
        inputElement.addEventListener('input', clearHandler);
    },

    // インラインエラー消去
    clearError: (elementId) => {
        const inputElement = document.getElementById(elementId);
        if (inputElement) {
            inputElement.classList.remove('border-error');
            const existingError = document.getElementById(`${elementId}-error`);
            if (existingError) existingError.remove();
        }
    },

    // 全てのエラーをクリア
    clearAllErrors: () => {
        document.querySelectorAll('.text-error').forEach(el => el.remove());
        document.querySelectorAll('.border-error').forEach(el => el.classList.remove('border-error'));
    }
};

// グローバルスコープに公開（既存コードからの移行を容易にするため）
window.UI = UI;
