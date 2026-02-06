/**
 * Navigation System - App Launcher Style
 * すべてのページで共通のナビゲーションバーとアプリランチャーを提供します。
 */

const TOOLS = [
    {
        category: "🌐 翻訳",
        items: [
            { name: "翻訳ツール", url: "/index.html", desc: "テキスト翻訳の基本ツール" },
            { name: "検証結果翻訳", url: "/verify.html", desc: "検証レポートを翻訳" },
            { name: "列指定翻訳", url: "/column-translate.html", desc: "Excel/CSVの列を指定して翻訳" },
            { name: "シート翻訳", url: "/sheet-translate.html", desc: "Excelシート全体を翻訳" },
            { name: "Word翻訳", url: "/word-translate.html", desc: "Wordファイルを翻訳" },
        ]
    },
    {
        category: "🔍 検品",
        items: [
            { name: "検品用マニュアル翻訳", url: "/pdftranslate.html", desc: "PDFマニュアルを切り抜いて翻訳" },
            { name: "検品リスト作成", url: "/inspection.html", desc: "PDFから検品項目を自動抽出" },
        ]
    },
    {
        category: "📝 マニュアル",
        items: [
            { name: "原稿作成（AIチェック）", url: "/manual.html", desc: "マニュアル原稿の校正・作成" },
            { name: "動画から原稿作成", url: "/media-manual.html", desc: "動画を解析して手順書を作成" },
        ]
    },
    {
        category: "★ その他",
        items: [
            { name: "修理レポート", url: "/report.html", desc: "修理報告書の作成支援" },
            { name: "検証項目作成", url: "/kensho.html", desc: "検証項目リストの作成" },
            { name: "単発プロンプト", url: "/prompt.html", desc: "自由にAIプロンプトを実行" },
        ]
    }
];

// 現在のページのタイトルを取得（HTMLのtitleタグから、またはURLから判定）
function getCurrentPageTitle() {
    return document.title || "AIツール";
}

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

    .app-brand {
        display: flex;
        align-items: center;
        gap: 12px;
        color: #fff;
        font-weight: 700;
        font-size: 1.1rem;
        text-decoration: none;
    }

    .app-brand img {
        height: 32px;
        width: auto;
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
        background: rgba(31, 41, 55, 0.9);
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
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
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
        gap: 8px;
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

    .tool-name {
        color: #f3f4f6;
        font-weight: 600;
        font-size: 0.95rem;
    }

    .tool-desc {
        color: #9ca3af;
        font-size: 0.8rem;
        line-height: 1.4;
    }

    /* Grid Icon for Button */
    .icon-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 2px;
        width: 16px;
        height: 16px;
    }

    .icon-dot {
        background: currentColor;
        border-radius: 2px;
    }

    @media (max-width: 640px) {
        .app-header { padding: 0 16px; height: 56px; }
        .launcher-content { padding: 24px; padding-top: 40px; }
        .tools-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
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

    // 既存のnav削除 (もしあれば)
    const existingNav = document.querySelector(".tool-nav");
    if (existingNav) existingNav.remove();

    // ヘッダー作成
    const header = document.createElement("header");
    header.className = "app-header";
    header.innerHTML = `
        <a href="#" class="app-brand">
            <!-- ロゴがあればここに -->
            <span>${getCurrentPageTitle()}</span>
        </a>
        <button class="launcher-btn" aria-label="アプリ一覧">
            ${createIconGrid()}
        </button>
    `;

    // ランチャー作成
    const launcher = document.createElement("div");
    launcher.className = "launcher-overlay";
    
    let launcherHtml = `
        <div class="launcher-content">
            <button class="launcher-close" aria-label="閉じる">
                ${createCloseIcon()}
            </button>
            <h2 class="text-2xl font-bold text-white mb-6">アプリ一覧</h2>
    `;

    TOOLS.forEach(category => {
        launcherHtml += `
            <div class="category-section">
                <div class="category-title">${category.category}</div>
                <div class="tools-grid">
        `;
        
        category.items.forEach(tool => {
            const isActive = location.pathname.endsWith(tool.url) || (tool.url === "/index.html" && location.pathname === "/");
            launcherHtml += `
                <a href="${tool.url}" class="tool-card ${isActive ? 'active' : ''}">
                    <span class="tool-name">${tool.name}</span>
                    <span class="tool-desc">${tool.desc}</span>
                </a>
            `;
        });

        launcherHtml += `
                </div>
            </div>
        `;
    });

    launcherHtml += `</div>`;
    launcher.innerHTML = launcherHtml;

    // Body先頭に挿入
    document.body.insertBefore(launcher, document.body.firstChild);
    document.body.insertBefore(header, document.body.firstChild);

    // イベント設定
    const btn = header.querySelector(".launcher-btn");
    const closeBtn = launcher.querySelector(".launcher-close");
    
    function toggleLauncher() {
        const isActive = launcher.classList.contains("active");
        if (isActive) {
            launcher.classList.remove("active");
            document.body.style.overflow = "";
        } else {
            launcher.classList.add("active");
            document.body.style.overflow = "hidden";
        }
    }

    btn.addEventListener("click", toggleLauncher);
    closeBtn.addEventListener("click", toggleLauncher);
    launcher.addEventListener("click", (e) => {
        if (e.target === launcher) toggleLauncher();
    });
    
    // ESCキーで閉じる
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && launcher.classList.contains("active")) {
            toggleLauncher();
        }
    });
});
