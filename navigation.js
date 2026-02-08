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

// CSSの注入 (削除: public/css/navigation.css に移行しました)

// Global Toast Function
window.showToast = function (msg, isError) {
    let t = document.getElementById("toast");
    if (!t) {
        t = document.createElement("div");
        t.id = "toast";
        document.body.appendChild(t);
    }

    t.innerText = msg;
    if (isError) {
        t.style.backgroundColor = "#ef4444"; // red
        t.style.color = "#ffffff";
    } else {
        t.style.backgroundColor = "#111827"; // dark
        t.style.color = "#f9fafb";
    }

    t.classList.add("show");

    // Clear existing timer if any
    if (t.dataset.timer) clearTimeout(parseInt(t.dataset.timer));

    const timer = setTimeout(() => {
        t.classList.remove("show");
    }, 3000);

    t.dataset.timer = timer;
};

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
// DOMContentLoadedではなくloadイベントを使用（CSS等全リソース読み込み後に実行）
window.addEventListener("load", () => {
    console.log("Navigation: 初期化開始");

    // スタイル挿入
    // CSSの注入 (削除済み: index.html等で読み込み)
    // const styleEl = document.createElement("style");
    // styleEl.textContent = ...
    // document.head.appendChild(styleEl);

    // 既存のnav削除
    const existingNav = document.querySelector(".tool-nav");
    if (existingNav) {
        console.log("Navigation: 既存のnavを削除");
        existingNav.remove();
    }

    // ランチャー作成（最初に作成）
    const launcher = document.createElement("div");
    launcher.className = "launcher-overlay";
    document.body.insertBefore(launcher, document.body.firstChild);

    // ヘッダー作成
    const header = document.createElement("header");
    header.className = "app-header";
    document.body.insertBefore(header, document.body.firstChild);

    // 描画関数
    function renderHeader() {
        console.log("Navigation: renderHeader開始");
        const pinnedUrls = PinManager.getPinnedUrls();
        console.log("Navigation: pinnedUrls =", pinnedUrls);
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

        // Cmd+K or Ctrl+K
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const shortcutKey = isMac ? '⌘K' : 'Ctrl+K';

        const pageTitle = getCurrentPageTitle();
        console.log("Navigation: pageTitle =", pageTitle);
        console.log("Navigation: shortcutKey =", shortcutKey);
        console.log("Navigation: createIconGrid() =", createIconGrid());

        const headerHtml = `
            <div class="header-left">
                <a href="/index.html" class="app-brand">
                    <span>${pageTitle}</span>
                </a>
                <div class="pinned-tools-container">
                    <div class="pinned-tools">
                        ${pinnedHtml}
                    </div>
                </div>
            </div>
            
            <button class="launcher-btn" aria-label="アプリ一覧">
                ${createIconGrid()}
                <span class="nav-tooltip">アプリ一覧 <span class="shortcut-hint">${shortcutKey}</span></span>
            </button>
        `;

        console.log("Navigation: headerHtml長さ =", headerHtml.length);
        console.log("Navigation: header要素 =", header);

        header.innerHTML = headerHtml;

        console.log("Navigation: header.innerHTML設定完了、長さ =", header.innerHTML.length);

        // ランチャー開閉イベント再設定
        const launcherBtn = header.querySelector(".launcher-btn");
        console.log("Navigation: launcherBtn =", launcherBtn);
        if (launcherBtn) {
            launcherBtn.addEventListener("click", toggleLauncher);
            console.log("Navigation: ランチャーボタンのイベントリスナー設定完了");
        } else {
            console.error("Navigation Error: ランチャーボタンが見つかりません");
            console.error("Navigation Error: header.innerHTML =", header.innerHTML);
            console.error("Navigation Error: header.children =", header.children);
        }

        // ピン留めツールの横スクロール対応（マウスホイール）
        const pinnedTools = header.querySelector(".pinned-tools");
        if (pinnedTools) {
            pinnedTools.addEventListener("wheel", (e) => {
                // 縦スクロールを横スクロールに変換
                if (e.deltaY !== 0) {
                    e.preventDefault();
                    pinnedTools.scrollLeft += e.deltaY;
                }
            }, { passive: false });
        }
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
                    <div class="tool-card ${isActive ? 'active' : ''}" data-url="${tool.url}">
                        <div class="tool-header">
                            <span class="tool-icon">${tool.icon}</span>
                            <button class="star-btn ${isPinned ? 'pinned' : ''}" data-url="${tool.url}" title="${isPinned ? 'ピン留め解除' : 'ピン留めする'}">
                                ${isPinned ? '★' : '☆'}
                            </button>
                        </div>
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
                e.stopPropagation(); // カードのクリックイベント防止
                e.preventDefault();
                const url = btn.dataset.url;
                PinManager.togglePin(url);
            });
        });

        // Tool Card Click Events
        launcher.querySelectorAll(".tool-card").forEach(card => {
            card.addEventListener("click", (e) => {
                // Starボタンのクリックは除外（既にstopPropagationで処理済み）
                const url = card.dataset.url;
                if (url) {
                    window.location.href = url;
                }
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
    console.log("Navigation: 初回描画開始");
    renderHeader();
    renderLauncher();
    console.log("Navigation: 初期化完了");

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

        // Cmd(Meta)+K or Ctrl+K
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            toggleLauncher();
        }
    });
});

