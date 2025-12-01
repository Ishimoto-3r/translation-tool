// api/manual-test.js

export default async function handler(req, res) {
  res.status(200).json({ message: "manual-test is alive" });
}
