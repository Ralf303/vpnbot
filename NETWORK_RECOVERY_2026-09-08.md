# Восстановление зарубежного выхода 8 сентября 2026

## Причина и результат

При диагностике WireGuard между RU и FI не устанавливал handshake более трёх
часов. Ping внутри него терял 100% пакетов, хотя публичные адреса отвечали
примерно за 17 мс. Пакеты UDP с RU не наблюдались на внешнем интерфейсе FI
на пяти проверенных портах. Новые TCP-соединения RU → FI также завершались
тайм-аутом. Локальные firewall и tc не содержали соответствующего запрета.
Это указывает на сетевую фильтрацию или неисправность между VPS; конкретный
провайдер и точное место потери не установлены.

Healthcheck правильно убрал недоступный финский маршрут, оставив московский
fallback. Прямые загрузки с VPS давали 250–390 Мбит/с, но пользователь наблюдал
около 400 байт/с через VPN на мобильной сети.

Рабочая пара серверов-примеров была проверена только чтением: TCP/54 на RU
через systemd-socket-proxyd передавался OpenVPN/TCP на зарубежном VPS. Там нет
межсерверного WireGuard. На серверах-примерах ничего не изменялось.

По выбору пользователя сохранена GeoIP-маршрутизация. OpenVPN, его TCP/443,
PKI, бот и клиентские профили остались на прежних местах. Для межсерверного
трафика включён SSH point-to-point туннель, инициируемый FI к RU.

```text
Телефон → TCP/443 RU → OpenVPN tun1 (10.9.0.0/24)
                           ├─ RU IPv4 → NAT RU → интернет
                           └─ прочее → table 210 → tun99 → NAT FI → интернет
                                      SSH/TCP соединение инициирует FI → RU
```

Проверки после переключения:

- 32 МиБ через туннель FI → RU: 52,27 Мбит/с;
- HTTPS-загрузка 10 МБ через финский маршрут: 46,31 Мбит/с;
- запросы с адреса OpenVPN и mark `0x210` показывают внешний IP FI;
- запросы без mark показывают внешний IP RU;
- российский тестовый адрес входит в nftables-набор `ru4`;
- ICMP с IP-размером 1400 байт проходит без потерь;
- пользователь подтвердил восстановление работы на телефоне в мобильной сети.

Это серверные замеры, а не измеренная скорость телефона. Отдельная блокировка
OpenVPN мобильным оператором не была доказана. Менять порт или шифры не потребовалось.

## Установленные компоненты

На обоих серверах:

- `vpnbot-transit-interface@.service` и `/usr/local/sbin/vpnbot-transit-interface`;
- постоянный TUN `tun99`, MTU 1400; RU `10.211.0.1/30`, FI `10.211.0.2/30`;
- `/etc/default/vpnbot-routing` из `deploy/vpnbot-routing-tcp.defaults`.

На RU:

- системная учётная запись `vpn-transit`, владелец TUN `tun99`;
- `/var/lib/vpn-transit/.ssh/authorized_keys`: отдельный ключ с
  `restrict,tunnel="99",command="/usr/bin/sleep infinity"`;
- `/etc/ssh/sshd_config.d/61-vpnbot-transit.conf`: только для этой учётной записи
  разрешён point-to-point tunnel, запрещены пароль и TCP forwarding;
- включён `vpnbot-transit-interface@ru.service`;
- drop-in `vpnbot-moscow-routing.service.d/transit.conf` из одноимённого deploy-файла;
- обновлены `vpnbot-route-health` и `vpnbot-moscow-routing`;
- TCP SYN в обоих направлениях `tun1 ↔ tun99` получает MSS не более 1360.

На FI:

- отдельный SSH-ключ `/etc/vpnbot-transit/id_ed25519` (0600);
- закреплённый host key RU в `/etc/vpnbot-transit/known_hosts`;
- `/etc/default/vpnbot-transit` с `VPN_TRANSIT_RU_HOST=<RU_PUBLIC_IP>`;
- включены `vpnbot-transit-interface@fi.service` и `vpnbot-transit.service`;
- drop-in `vpnbot-finland-egress.service.d/transit.conf` из deploy-файла;
- обновлён `vpnbot-finland-egress`: возврат к `10.9.0.0/24` через `tun99`.

Сервис SSH-туннеля повторяет подключение при ошибке. Проверка маршрута каждые
10 секунд проверяет `10.211.0.2` и при отказе убирает table 210 / rule 10210.
Она автоматически восстанавливает зарубежный маршрут после возвращения канала.
WireGuard сохранён, но сейчас не выбран транспортом для пользовательского трафика.
Без `/etc/default/vpnbot-routing` скрипты сохраняют исходные WireGuard defaults.

## Проверка и откат

На RU:

```bash
systemctl status vpnbot-transit-interface@ru vpnbot-route-health.timer
ping -c 3 -M do -s 1372 10.211.0.2
ip rule show
ip route show table 210
ip route get 1.1.1.1 from 10.9.0.1 mark 0x210
iptables -t mangle -L FORWARD -nv
```

На FI:

```bash
systemctl status vpnbot-transit
journalctl -u vpnbot-transit -n 30
ip route show 10.9.0.0/24
```

Сценарии выбора WireGuard по умолчанию, выбора SSH, удаления недоступного
маршрута и повторного запуска без дубликатов проверяются без изменения сети:

```bash
python3 tests/routing-health.test.py deploy/vpnbot-route-health
```

Исходные скрипты сохранены на соответствующих серверах в
`/root/vpnbot-network-backup-20260908/`. Для возврата к WireGuard сначала
подтвердить его двустороннюю доступность. Затем на обоих серверах отключить
выбор SSH в `/etc/default/vpnbot-routing`, на FI выполнить
`/usr/local/sbin/vpnbot-finland-egress up`, на RU —
`/usr/local/sbin/vpnbot-route-health`. После проверки маршрутов можно остановить
`vpnbot-transit.service` на FI. Если WireGuard по-прежнему недоступен, такой
откат вернёт московский fallback, а не исправный финский выход.

При полном удалении TCP-транспорта также удалить только его два MSS-правила,
два systemd drop-in, отдельную SSH match-конфигурацию и собственные сервисы.
Перед reload SSH обязательно выполнить `sshd -t`. Действующие сервисы
OpenVPN и управляющие SSH/SOCKS-туннели для этого перезапускать не требуется.
