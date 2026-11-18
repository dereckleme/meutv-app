# Meu IPTV (Samsung Tizen)

App web Tizen: login Xtream Codes (ou URL M3U `get.php?username=..&password=..`), Ao vivo / Filmes / Séries, busca, player AVPlay.

## Instalar na TV
1. TV: Apps → digite `12345` no controle → **Developer mode ON** → IP do seu Mac → reinicie a TV.
2. Instale o **Tizen Studio** (com *TV Extensions*), abra **Device Manager** → *Remote Device Manager* → adicione o IP da TV → Connection ON.
3. Tizen Studio → *Certificate Manager* → crie um certificado **Samsung** (login Samsung Account; o DUID da TV entra automaticamente).
4. *File → Open Projects* → esta pasta → botão direito → **Run As → Tizen Web Application**.

Via terminal (com Tizen Studio no PATH):
```bash
tizen package -t wgt -s <perfil-do-certificado> -- .
sdb connect <IP-DA-TV>
tizen install -n MeuIPTV.wgt -t <nome-do-device>
```

## Controle
Setas navegam · OK seleciona · VOLTAR volta/fecha player · No player: ▲▼/CH± troca canal, ◄► ±10s, OK pausa.

## Notas
- Credenciais ficam só no `localStorage` da TV.
- Live tenta `.m3u8` e, se falhar, `.ts`.
- Se o AVPlay reclamar de permissão, adicione em `config.xml` o privilégio de AVPlay que o Tizen Studio sugerir.
