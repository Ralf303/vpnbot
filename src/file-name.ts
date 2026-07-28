const CLIENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function vpnFileName(clientName: string): string {
  if (!CLIENT_NAME.test(clientName)) {
    throw new Error("Недопустимое техническое имя VPN-конфига");
  }
  return `${clientName}.ovpn`;
}
