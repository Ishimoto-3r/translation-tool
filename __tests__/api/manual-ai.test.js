
const nodeMocks = require('node-mocks-http');

// OpenAIモック
const mockChatCompletion = jest.fn();
jest.mock('openai', () => {
    return jest.fn().mockImplementation(() => {
        return {
            chat: {
                completions: {
                    create: mockChatCompletion
                }
            }
        };
    });
});

// utils/prompts モック
jest.mock('../../lib/prompts', () => ({
    MANUAL_AI_PROMPTS: {
        MEDIA_MANUAL_SYSTEM: "SysPrompt",
        MEDIA_MANUAL_USER_TEMPLATE: jest.fn((notes, gran, count) => `UserText: ${notes} ${gran} ${count}`)
    }
}), { virtual: true });

describe('API Manual AI (manual-ai.js)', () => {
    let handler;

    beforeEach(async () => {
        jest.clearAllMocks();
        process.env.OPENAI_API_KEY = "dummy-key";

        // CommonJSとしてインポート
        handler = require('../../api/manual-ai');
    });

    test('POST以外のメソッド: 405', async () => {
        const { req, res } = nodeMocks.createMocks({ method: 'GET' });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(405);
    });

    test('Normal Mode Check: プロンプトあり', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {
                prompt: "Checking text",
                mode: "check"
            }
        });

        mockChatCompletion.mockResolvedValue({
            choices: [{ message: { content: "Checked Result" } }]
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.text).toBe("Checked Result");
        expect(mockChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
            model: expect.stringContaining("gpt-5.2") // defined in manual-ai.js as fallback
        }));
    });

    test('Normal Mode Image: 画像URLあり', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {
                prompt: "Vision check",
                image: "data:image/png;base64,dummy",
                mode: "image" // not check
            }
        });

        mockChatCompletion.mockResolvedValue({
            choices: [{ message: { content: "Vision Result" } }]
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        expect(mockChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
            messages: expect.arrayContaining([
                expect.objectContaining({
                    role: "user",
                    content: expect.arrayContaining([
                        { type: "image_url", image_url: { url: "data:image/png;base64,dummy" } }
                    ])
                })
            ])
        }));
    });

    test('Media Manual Mode: 画像とノート', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {
                mode: "media-manual",
                notes: "Manual Note",
                images: [{ dataUrl: "data:image/jpeg;base64,img1" }]
            }
        });

        mockChatCompletion.mockResolvedValue({
            choices: [{ message: { content: "Manual Text" } }]
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(200);
        const data = JSON.parse(res._getData());
        expect(data.text).toBe("Manual Text");
        expect(mockChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
            messages: expect.arrayContaining([
                { role: "system", content: "SysPrompt" },
                { role: "user", content: expect.any(Array) }
            ])
        }));
    });

    test('Media Manual Mode: 画像なしエラー', async () => {
        const { req, res } = nodeMocks.createMocks({
            method: 'POST',
            body: {
                mode: "media-manual",
                images: []
            }
        });

        await handler(req, res);

        expect(res._getStatusCode()).toBe(400);
        expect(JSON.parse(res._getData())).toEqual({ error: "NoImages" });
    });
});
