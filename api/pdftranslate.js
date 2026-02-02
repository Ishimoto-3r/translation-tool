export default function handler(req, res) {
    res.status(200).json({ status: "alive", type: "minimal", timestamp: Date.now() });
}
