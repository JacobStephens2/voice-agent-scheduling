import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scheduler HTTPS vhost", () => {
  const conf = readFileSync(new URL("../ops/apache/scheduler.stephens.page.conf", import.meta.url), "utf8");
  const https = conf.split("<VirtualHost *:443>")[1]?.split("</VirtualHost>")[0] ?? "";

  it("writes its own access log and leaves /calendar/auth/ requests out of that log", () => {
    expect(https).toMatch(/SetEnvIf Request_URI "\^\/calendar\/auth\/" calendar_auth/);
    expect(https).toMatch(
      /CustomLog \/var\/log\/apache2\/scheduler\.stephens\.page-access\.log combined env=!calendar_auth/,
    );
  });
});
