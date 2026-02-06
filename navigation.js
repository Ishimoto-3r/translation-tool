/**
 * Navigation System - App Launcher Style
 * すべてのページで共通のナビゲーションバーとアプリランチャーを提供します。
 * 機能:
 * - アプリランチャー（全ツール一覧）
 * - クイックアクセス（お気に入りピン留め）
 * - LocalStorageによる設定保存
 */

const TOOLS = [
    {
        category: "🌐 翻訳",
        items: [
            { name: "翻訳ツール", url: "/index.html", desc: "テキスト翻訳の基本ツール", icon: "🌐" },
            { name: "検証結果翻訳", url: "/verify.html", desc: "検証レポートを翻訳", icon: "🔍" },
            { name: "列指定翻訳", url: "/column-translate.html", desc: "Excel/CSVの列を指定して翻訳", icon: "📊" },
            { name: "シート翻訳", url: "/sheet-translate.html", desc: "Excelシート全体を翻訳", icon: "📑" },
            { name: "Word翻訳", url: "/word-translate.html", desc: "Wordファイルを翻訳", icon: "📝" },
        ]
    },
    {
        category: "🔍 検品",
        items: [
            { name: "検品用マニュアル翻訳", url: "/pdftranslate.html", desc: "PDFマニュアルを切り抜いて翻訳", icon: "📖" },
            { name: "検品リスト作成", url: "/inspection.html", desc: "PDFから検品項目を自動抽出", icon: "📋" },
        ]
    },
    {
        category: "📝 マニュアル",
        items: [
            { name: "原稿作成（AIチェック）", url: "/manual.html", desc: "マニュアル原稿の校正・作成", icon: "✍️" },
            { name: "動画から原稿作成", url: "/media-manual.html", desc: "動画を解析して手順書を作成", icon: "🎥" },
        ]
    },
    {
        category: "★ その他",
        items: [
            { name: "修理レポート", url: "/report.html", desc: "修理報告書の作成支援", icon: "🛠️" },
            { name: "検証項目作成", url: "/kensho.html", desc: "検証項目リストの作成", icon: "✅" },
            { name: "単発プロンプト", url: "/prompt.html", desc: "自由にAIプロンプトを実行", icon: "💡" },
        ]
    }
];

// デフォルトのピン留めアイテム（ユーザー指定）
const DEFAULT_PINNED = [
    "/index.html",   // 翻訳ツール
    "/report.html",  // 修理レポート
    "/kensho.html",  // 検証項目作成
    "/verify.html",  // 検証結果翻訳
    "/manual.html"   // 原稿作成
];

// 現在のページのタイトルを取得
function getCurrentPageTitle() {
    return document.title || "AIツール";
}

// ツールURLからツール情報を検索
function findToolByUrl(url) {
    for (const cat of TOOLS) {
        for (const item of cat.items) {
            if (item.url === url) return item;
        }
    }
    return null;
}

// ピン留め状態管理
const PinManager = {
    key: 'antigravity_pinned_tools',
    getPinnedUrls() {
        try {
            const saved = localStorage.getItem(this.key);
            return saved ? JSON.parse(saved) : DEFAULT_PINNED;
        } catch (e) {
            console.error("Storage Error:", e);
            return DEFAULT_PINNED;
        }
    },
    togglePin(url) {
        let current = this.getPinnedUrls();
        if (current.includes(url)) {
            current = current.filter(u => u !== url);
        } else {
            current.push(url);
        }
        localStorage.setItem(this.key, JSON.stringify(current));
        // イベント発火
        window.dispatchEvent(new CustomEvent('pinned-tools-changed'));
    },
    isPinned(url) {
        return this.getPinnedUrls().includes(url);
    }
};

// CSSの注入
const STYLE = `
    /* Navigation Bar */
    .app-header {
        position: sticky;
        top: 0;
        z-index: 1000;
        background: rgba(17, 24, 39, 0.95);
        backdrop-filter: blur(8px);
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        padding: 0 24px;
        height: 64px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 24px;
        flex: 1;
        overflow: hidden; /* コンテンツが多い場合用 */
    }

    .app-brand {
        display: flex;
        align-items: center;
        gap: 12px;
        color: #fff;
        font-weight: 700;
        font-size: 1.1rem;
        text-decoration: none;
        white-space: nowrap;
        margin-right: 16px;
    }

    /* Pinned Tools Area */
    .pinned-tools {
        display: flex;
        align-items: center;
        gap: 8px;
        overflow-x: auto; /* はみ出し対応 */
        scrollbar-width: none; /* Firefox */
        -ms-overflow-style: none; /* IE/Edge */
    }
    .pinned-tools::-webkit-scrollbar { display: none; } /* Chrome/Safari */

    .pin-link {
        display: flex;
        align-items: center;
        gap: 6px;
        color: rgba(229, 231, 235, 0.8);
        text-decoration: none;
        font-size: 0.85rem;
        font-weight: 500;
        padding: 6px 12px;
        border-radius: 6px;
        transition: all 0.2s;
        white-space: nowrap;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid transparent;
    }

    .pin-link:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
    }

    .pin-link.active {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
        border-color: rgba(59, 130, 246, 0.3);
    }

    .launcher-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #fff;
        width: 40px;
        height: 40px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s;
        flex-shrink: 0;
        margin-left: 16px;
    }

    .launcher-btn:hover {
        background: rgba(255, 255, 255, 0.2);
    }

    /* Launcher Overlay */
    .launcher-overlay {
        position: fixed;
        inset: 0;
        z-index: 2000;
        background: rgba(17, 24, 39, 0.6);
        backdrop-filter: blur(12px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 80px;
        overflow-y: auto;
    }

    .launcher-overlay.active {
        opacity: 1;
        pointer-events: auto;
    }

    .launcher-content {
        width: min(1000px, 90%);
        background: rgba(31, 41, 55, 0.95);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 24px;
        padding: 40px;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
        transform: translateY(-20px);
        transition: transform 0.3s ease;
        margin-bottom: 40px;
    }

    .launcher-overlay.active .launcher-content {
        transform: translateY(0);
    }

    .launcher-close {
        position: absolute;
        top: 24px;
        right: 24px;
        background: none;
        border: none;
        color: #9ca3af;
        cursor: pointer;
        padding: 8px;
        border-radius: 50%;
        transition: all 0.2s;
    }

    .launcher-close:hover {
        background: rgba(255,255,255,0.1);
        color: #fff;
    }

    .category-section {
        margin-bottom: 40px;
    }

    .category-section:last-child {
        margin-bottom: 0;
    }

    .category-title {
        color: #e5e7eb;
        font-size: 0.9rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        margin-bottom: 16px;
        border-bottom: 1px solid rgba(255,255,255,0.1);
        padding-bottom: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .tools-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 16px;
    }

    .tool-card {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.05);
        border-radius: 12px;
        padding: 16px;
        text-decoration: none;
        transition: all 0.2s;
        display: flex;
        flex-direction: column;
        gap: 6px;
        position: relative; /* for star btn */
    }

    .tool-card:hover {
        background: rgba(255, 255, 255, 0.1);
        transform: translateY(-2px);
        border-color: rgba(255, 255, 255, 0.2);
    }

    .tool-card.active {
        background: rgba(59, 130, 246, 0.2);
        border-color: rgba(59, 130, 246, 0.5);
    }

    .tool-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
    }

    .tool-icon { font-size: 1.5rem; margin-bottom: 4px; display: block; }
    .tool-name { color: #f3f4f6; font-weight: 600; font-size: 0.95rem; }
    .tool-desc { color: #9ca3af; font-size: 0.75rem; line-height: 1.4; }

    /* Star Button */
    .star-btn {
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.2);
        cursor: pointer;
        padding: 4px;
        font-size: 1.2rem;
        line-height: 1;
        transition: all 0.2s;
        z-index: 2; /* リンクより上に */
    }
    .star-btn:hover { color: rgba(255, 255, 255, 0.6); transform: scale(1.1); }
    .star-btn.pinned { color: #fbbf24; } /* Gold */

    /* Grid Icon for Button */
    .icon-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 2px;
        width: 16px;
        height: 16px;
    }
    .icon-dot { background: currentColor; border-radius: 2px; }

    @media (max-width: 768px) {
        .header-left { gap: 12px; }
        .app-brand span { display: none; } /* スマホではタイトル隠す */
        .app-brand::before { content: "AI"; } /* 代わりに短いロゴ */
        .pin-link span:not(.icon) { display: none; } /* スマホでは文字隠す？いや、ユーザーは不要と言ったが念のため */
    }
`;

function createIconGrid() {
    return `
        <div class="icon-grid">
            <div class="icon-dot"></div><div class="icon-dot"></div><div class="icon-dot"></div>
            <div class="icon-dot"></div><div class="icon-dot"></div><div class="icon-dot"></div>
            <div class="icon-dot"></div><div class="icon-dot"></div><div class="icon-dot"></div>
        </div>
    `;
}

function createCloseIcon() {
    return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
}

// 初期化
document.addEventListener("DOMContentLoaded", () => {
    // スタイル挿入
    const styleEl = document.createElement("style");
    styleEl.textContent = STYLE;
    document.head.appendChild(styleEl);

    // 既存のnav削除
    const existingNav = document.querySelector(".tool-nav");
    if (existingNav) existingNav.remove();

    // ヘッダー作成
    const header = document.createElement("header");
    header.className = "app-header";
    // 内部は後でrenderHeaderで描画
    document.body.insertBefore(header, document.body.firstChild);

    // ランチャー作成
    const launcher = document.createElement("div");
    launcher.className = "launcher-overlay";
    document.body.insertBefore(launcher, document.body.firstChild);

    // 描画関数
    function renderHeader() {
        const pinnedUrls = PinManager.getPinnedUrls();
        let pinnedHtml = '';

        pinnedUrls.forEach(url => {
            const tool = findToolByUrl(url);
            if (tool) {
                const isActive = location.pathname.endsWith(tool.url) || (tool.url === "/index.html" && location.pathname === "/");
                pinnedHtml += `
                    <a href="${tool.url}" class="pin-link ${isActive ? 'active' : ''}" title="${tool.name}">
                        <span class="icon">${tool.icon}</span>
                        <span>${tool.name}</span>
                    </a>
                `;
            }
        });

        header.innerHTML = `
            <div class="header-left">
                <a href="/index.html" class="app-brand">
                    <span>${getCurrentPageTitle()}</span>
                </a>
                <div class="pinned-tools">
                    ${pinnedHtml}
                </div>
            </div>
            
            <button class="launcher-btn" aria-label="アプリ一覧">
                ${createIconGrid()}
            </button>
        `;

        // ランチャー開閉イベント再設定
        header.querySelector(".launcher-btn").addEventListener("click", toggleLauncher);
    }

    function renderLauncher() {
        const pinnedUrls = PinManager.getPinnedUrls();

        let launcherHtml = `
            <div class="launcher-content">
                <button class="launcher-close" aria-label="閉じる">
                    ${createCloseIcon()}
                </button>
                <div class="flex justify-between items-center mb-6">
                    <h2 class="text-2xl font-bold text-white">アプリ一覧</h2>
                    <div class="text-sm text-gray-400">☆をクリックしてよく使うツールに追加</div>
                </div>
        `;

        TOOLS.forEach(category => {
            launcherHtml += `
                <div class="category-section">
                    <div class="category-title">${category.category}</div>
                    <div class="tools-grid">
            `;

            category.items.forEach(tool => {
                const isActive = location.pathname.endsWith(tool.url) || (tool.url === "/index.html" && location.pathname === "/");
                const isPinned = pinnedUrls.includes(tool.url);

                launcherHtml += `
                    <div class="tool-card ${isActive ? 'active' : ''}">
                        <div class="tool-header">
                            <span class="tool-icon">${tool.icon}</span>
                            <button class="star-btn ${isPinned ? 'pinned' : ''}" data-url="${tool.url}" title="${isPinned ? 'ピン留め解除' : 'ピン留めする'}">
                                ${isPinned ? '★' : '☆'}
                            </button>
                        </div>
                        <a href="${tool.url}" class="absolute inset-0 z-0"></a>
                        <span class="tool-name">${tool.name}</span>
                        <span class="tool-desc">${tool.desc}</span>
                    </div>
                `;
            });

            launcherHtml += `
                    </div>
                </div>
            `;
        });

        launcherHtml += `</div>`;
        launcher.innerHTML = launcherHtml;

        // イベント設定
        launcher.querySelector(".launcher-close").addEventListener("click", toggleLauncher);

        // Star Button Events
        launcher.querySelectorAll(".star-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation(); // リンク遷移防止
                e.preventDefault();
                const url = btn.dataset.url;
                PinManager.togglePin(url);
            });
        });
    }

    // Toggle Launcher
    function toggleLauncher() {
        const isActive = launcher.classList.contains("active");
        if (isActive) {
            launcher.classList.remove("active");
            document.body.style.overflow = "";
        } else {
            renderLauncher(); // 開くたびに再描画（ピン状態同期のため）
            launcher.classList.add("active");
            document.body.style.overflow = "hidden";
        }
    }

    // 初回描画
    renderHeader();
    renderLauncher();

    // イベント: ピン留め変更時に再描画
    window.addEventListener('pinned-tools-changed', () => {
        renderHeader();
        renderLauncher(); // Launcher内も★の状態更新が必要
    });

    launcher.addEventListener("click", (e) => {
        if (e.target === launcher) toggleLauncher();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && launcher.classList.contains("active")) {
            toggleLauncher();
        }
    });
});

