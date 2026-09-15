import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import packet from "dns-packet";
let address = "192.0.2.1";
let drop = false;
let requests = 0;
let deliveries = 0;
for (const port of [5353, 5354, 5355]) {
  const socket = createSocket("udp4");
  socket.on("message", (buffer, peer) => {
    requests++;
    if (drop) return;
    const query = packet.decode(buffer);
    setTimeout(
      () =>
        socket.send(
          packet.encode({
            type: "response",
            id: query.id,
            flags: packet.AUTHORITATIVE_ANSWER,
            questions: query.questions,
            answers: query.questions.map((q) => ({
              name: q.name,
              type: "A",
              ttl: 60,
              data: address,
            })),
          }),
          peer.port,
          peer.address,
        ),
      20,
    );
  });
  socket.bind(port, "0.0.0.0");
}
createServer((req, res) => {
  if (req.method === "POST" && req.url === "/alert") {
    deliveries++;
    req.resume();
  } else if (req.method === "POST") {
    const url = new URL(req.url, "http://fixture");
    if (url.searchParams.has("address"))
      address = url.searchParams.get("address");
    if (url.searchParams.has("drop"))
      drop = url.searchParams.get("drop") === "true";
  }
  res.end(JSON.stringify({ address, drop, requests, deliveries }));
}).listen(8080, "0.0.0.0");
