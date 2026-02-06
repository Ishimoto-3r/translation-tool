/**
 * ナビゲーションシステムのテスト
 * 
 * テスト対象：
 * - PinManager（ピン留め機能）
 * - ツール検索機能
 */

describe('ナビゲーションシステム', () => {
    // LocalStorageのモック
    let localStorageMock;
    let PinManager; // ここでは宣言のみ

    beforeEach(() => {
        // LocalStorageのモック実装
        localStorageMock = (() => {
            let store = {};
            return {
                getItem: (key) => store[key] || null,
                setItem: (key, value) => {
                    store[key] = value.toString();
                },
                clear: () => {
                    store = {};
                },
                removeItem: (key) => {
                    delete store[key];
                }
            };
        })();

        // グローバルlocalStorageを置き換え
        global.localStorage = localStorageMock;

        // 各テストごとにPinManagerを再定義（LocalStorageのクリーンスイート）
        PinManager = {
            key: 'antigravity_pinned_tools',
            defaultPinned: [
                '/index.html',
                '/report.html',
                '/kensho.html',
                '/verify.html',
                '/manual.html'
            ],
            getPinnedUrls() {
                try {
                    const saved = localStorage.getItem(this.key);
                    return saved ? JSON.parse(saved) : this.defaultPinned;
                } catch (e) {
                    return this.defaultPinned;
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
            },
            isPinned(url) {
                return this.getPinnedUrls().includes(url);
            }
        };
    });

    afterEach(() => {
        localStorageMock.clear();
    });

    describe('PinManager', () => {

        test('デフォルトのピン留めツールが正しく取得できる', () => {
            const pinned = PinManager.getPinnedUrls();

            expect(pinned).toContain('/index.html');
            expect(pinned).toContain('/report.html');
            expect(pinned).toContain('/kensho.html');
            expect(pinned).toContain('/verify.html');
            expect(pinned).toContain('/manual.html');
            expect(pinned.length).toBe(5);
        });

        test('新しいツールをピン留めできる', () => {
            const newTool = '/pdftranslate.html';

            PinManager.togglePin(newTool);

            expect(PinManager.isPinned(newTool)).toBe(true);
            const pinned = PinManager.getPinnedUrls();
            expect(pinned).toContain(newTool);
            expect(pinned.length).toBe(6); // 5 + 1
        });

        test('ピン留めしたツールを解除できる', () => {
            const tool = '/index.html';

            // 最初はピン留めされている（デフォルト）
            expect(PinManager.isPinned(tool)).toBe(true);

            // 解除
            PinManager.togglePin(tool);

            expect(PinManager.isPinned(tool)).toBe(false);
            const pinned = PinManager.getPinnedUrls();
            expect(pinned).not.toContain(tool);
            expect(pinned.length).toBe(4); // 5 - 1
        });

        test('同じツールを2回toggleすると元に戻る', () => {
            const tool = '/pdftranslate.html';

            // 最初は未ピン留め
            expect(PinManager.isPinned(tool)).toBe(false);

            // ピン留め
            PinManager.togglePin(tool);
            expect(PinManager.isPinned(tool)).toBe(true);

            // 解除
            PinManager.togglePin(tool);
            expect(PinManager.isPinned(tool)).toBe(false);
        });

        test('LocalStorageに保存されたデータを正しく読み込む', () => {
            const customPinned = ['/index.html', '/pdftranslate.html'];
            localStorage.setItem('antigravity_pinned_tools', JSON.stringify(customPinned));

            const pinned = PinManager.getPinnedUrls();

            expect(pinned).toEqual(customPinned);
        });

        test('LocalStorageが壊れている場合、デフォルトを返す', () => {
            // 不正なJSON
            localStorage.setItem('antigravity_pinned_tools', 'invalid json{]');

            const pinned = PinManager.getPinnedUrls();

            expect(pinned).toEqual(PinManager.defaultPinned);
        });
    });

    describe('ツール検索機能', () => {
        const TOOLS = [
            {
                category: '🌐 翻訳',
                items: [
                    { name: '翻訳ツール', url: '/index.html', desc: 'テキスト翻訳', icon: '🌐' },
                    { name: '検証結果翻訳', url: '/verify.html', desc: '検証レポート翻訳', icon: '🔍' }
                ]
            },
            {
                category: '🔍 検品',
                items: [
                    { name: '検品用マニュアル翻訳', url: '/pdftranslate.html', desc: 'PDFマニュアル翻訳', icon: '📖' }
                ]
            }
        ];

        const findToolByUrl = (url) => {
            for (const cat of TOOLS) {
                for (const item of cat.items) {
                    if (item.url === url) return item;
                }
            }
            return null;
        };

        test('URLからツール情報を正しく取得できる', () => {
            const tool = findToolByUrl('/index.html');

            expect(tool).not.toBeNull();
            expect(tool.name).toBe('翻訳ツール');
            expect(tool.icon).toBe('🌐');
        });

        test('複数のカテゴリからツールを検索できる', () => {
            const tool1 = findToolByUrl('/verify.html');
            const tool2 = findToolByUrl('/pdftranslate.html');

            expect(tool1.name).toBe('検証結果翻訳');
            expect(tool2.name).toBe('検品用マニュアル翻訳');
        });

        test('存在しないURLの場合nullを返す', () => {
            const tool = findToolByUrl('/nonexistent.html');

            expect(tool).toBeNull();
        });
    });
});
