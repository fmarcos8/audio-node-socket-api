# Órbita

Aplicativo de conversa para desktop feito com **Electron**, Node.js, Socket.IO e WebRTC. Inclui canais de texto, edição e exclusão de mensagens, anexos configuráveis de até 100 MB, duas salas de voz com indicador de quem fala, microfone, silenciar áudio, compartilhamento de tela em janela separada e histórico das últimas 200 mensagens por canal.

## Requisitos

- Node.js 20 ou mais recente e npm.
- Windows, macOS ou Linux com microfone. Para compartilhar a tela no macOS, conceda a permissão de gravação de tela ao aplicativo.

## Começar no seu computador

```bash
npm install
npm start
```

Na primeira tela, escolha um nome e clique em **Criar servidor neste computador**. O app abrirá o servidor e entrará nele. Clique no título **Meu espaço** para copiar o endereço e o código de acesso. Passe ambos a outra pessoa na mesma rede local; ela abre o app, preenche os três campos e clica em **Entrar no servidor**.

Se o sistema solicitar permissão de rede, permita conexões à porta exibida no endereço. O servidor criado dentro do app só fica ativo enquanto o aplicativo do anfitrião estiver aberto. A porta é escolhida automaticamente a cada abertura.

## Servidor permanente

Você pode executar o servidor num computador ou VPS e deixar o app Electron somente como cliente:

```bash
# Linux/macOS
ORBITA_CODE='um-codigo-longo-e-secreto' PORT=3000 npm run server
```

```powershell
# PowerShell
$env:ORBITA_CODE = 'um-codigo-longo-e-secreto'
$env:PORT = '3000'
npm run server
```

No app, informe o endereço completo, por exemplo `http://192.168.1.10:3000`, seu nome e o mesmo código. O histórico fica em `data/messages.json` na pasta de onde o servidor foi iniciado. `DATA_DIR` altera essa pasta e `HOST` altera a interface de rede usada pelo servidor.

## Docker + Cloudflare Tunnel no servidor Ubuntu

Este projeto inclui `Dockerfile.server` e `compose.yaml`. O contêiner executa **apenas o servidor Node.js**. Cada pessoa continua usando o aplicativo Electron no próprio computador.

No servidor, dentro da pasta do projeto:

```bash
cp .env.example .env
```

Edite `.env` e escolha um `ORBITA_CODE` longo e privado. Depois:

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/
```

O `curl` deve retornar `Órbita online`. O Compose publica a porta 3000 **somente em 127.0.0.1 no host**, permitindo acesso ao `cloudflared` instalado como serviço nesse mesmo Ubuntu. O histórico e os anexos ficam no volume persistente `orbita-data`, mesmo após recriar o contêiner. Para acompanhar erros: `docker compose logs -f orbita`.

Se a conexão cair por alguns instantes, o cliente tenta reconectar e voltar à sala de voz anterior, mantendo microfone e compartilhamento ativos. Se o microfone tiver sido encerrado pelo sistema, o cliente tenta capturá-lo novamente. Ligações WebRTC com falha tentam reiniciar a conexão de mídia e, se necessário, recriar a ligação com o colega. Para investigar quedas recorrentes, consulte `docker compose logs -f orbita`: o servidor registra o motivo informado pelo Socket.IO ao desconectar cada usuário.

No túnel existente, adicione um hostname público, por exemplo `orbita.seu-dominio.com`, apontando para **`http://localhost:3000`**. Se você gerencia o túnel por arquivo `config.yml`, acrescente a regra antes da regra final `http_status:404` e reinicie o serviço:

```yaml
ingress:
  # mantenha aqui suas outras regras
  - hostname: orbita.seu-dominio.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
sudo systemctl restart cloudflared
```

Se você configura o túnel pelo painel da Cloudflare, crie o hostname publicado com o mesmo endereço de serviço (`http://localhost:3000`). Nesse caso, salve a rota no painel. No Electron, entre usando **`https://orbita.seu-dominio.com`**, seu nome e o código do `.env`.

**Voz e tela:** o túnel publica o HTTP/WebSocket usado pelo chat e pela sinalização. As mídias WebRTC tentam uma conexão entre os participantes via STUN; o túnel HTTP não atua como retransmissor TURN para essa mídia. Se a chamada funcionar na mesma rede mas não entre redes diferentes, configure um serviço TURN acessível aos clientes pela internet e preencha `ICE_SERVERS` no `.env`. Recrie o contêiner com `docker compose up -d` após alterar o arquivo. Não configure `turn:localhost` no app remoto: o endereço TURN precisa ser alcançável pelos computadores dos participantes.

Se o seu `cloudflared` estiver **dentro de outro contêiner**, `localhost` apontará para aquele contêiner. Nesse caso, conecte os dois serviços à mesma rede Docker e use `http://orbita:3000` como origem do túnel.

Para acessar pela internet, coloque o servidor atrás de HTTPS/WSS com um proxy reverso e use um endereço `https://...`. O áudio e o vídeo são enviados entre participantes por WebRTC. Em algumas redes, o STUN padrão não consegue estabelecer a conexão; configure um servidor TURN seu no processo do servidor:

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.exemplo.com:3478","username":"usuario","credential":"senha"}]' ORBITA_CODE='um-codigo-longo-e-secreto' npm run server
```

Use salas pequenas: cada participante envia áudio e tela diretamente a cada outro participante. Este protótipo não possui contas, moderação, criptografia do histórico ou armazenamento na nuvem. O código de acesso e os dados de conexão são guardados localmente no aplicativo; ao reabrir, ele tenta entrar automaticamente no último servidor. Use **Trocar servidor** para apagar essa conexão salva. Compartilhe o código somente com pessoas de confiança.

### Mensagens e arquivos

- Use o clipe ao lado da caixa de mensagem para anexar um arquivo; ele só é enviado ao clicar em **Enviar**. Clique no cartão do arquivo para baixá-lo. O limite inicial é 8 MB e pode ser alterado entre 1 e 100 MB na engrenagem de **Configurações**. Essa preferência é individual de cada instalação; o servidor aceita até 100 MB. Alterações são aplicadas imediatamente.
- Passe o mouse sobre uma mensagem sua para editar ou excluir. O servidor verifica a autoria, mesmo que outra pessoa escolha o mesmo nome.
- A autoria é associada a uma chave aleatória guardada neste dispositivo. Se você apagar os dados locais do aplicativo, perderá a possibilidade de editar ou excluir as mensagens enviadas anteriormente. Mensagens criadas por versões anteriores à 0.2.0 não têm essa chave e permanecem no histórico, mas não podem ser editadas ou excluídas por segurança.
- A exclusão de uma mensagem também remove seu anexo. Quando um canal ultrapassa 200 mensagens, os anexos das mensagens mais antigas são removidos junto com elas.
- Os ícones são do pacote [Lucide](https://lucide.dev/), distribuídos com a licença em `renderer/icons/LICENSE`.

### Navegação e chamada de voz

- Clique numa sala de voz para abrir a tela da chamada: ela mostra participantes, quem está falando e os compartilhamentos de tela. O chat de texto não aparece nessa visualização.
- Ajuste o controle de volume no cartão de cada colega. O nível é salvo por pessoa e servidor neste dispositivo; o botão de desativar áudio continua silenciando toda a sala.
- Clique num canal de texto para voltar ao chat. Você permanece conectado à sala de voz até clicar em **Sair** ou **Desconectar**; o painel de conexão continua na barra lateral.
- Use **Ligar câmera** na sala de voz para mostrar a webcam no seu cartão, no lugar da foto. Em **Configurações → Webcam**, escolha a câmera, a resolução (360p, 720p ou 1080p), a taxa de quadros (15, 24 ou 30 FPS) e um filtro (preto e branco, sépia, quente, contraste ou suavizar). A resolução e os FPS podem ser alterados durante a chamada, inclusive com filtro ativo; dependem dos recursos da webcam e da rede. O filtro é aplicado ao vídeo enviado para os colegas; as preferências ficam salvas neste dispositivo. Desligar a câmera ou sair da sala encerra a captura.
- A sala de voz mostra cartões maiores para os participantes. Cada tela compartilhada aparece em um cartão separado, abaixo deles. O botão no cartão da webcam ou da tela abre uma janela independente maximizada; ao fechá-la, a imagem continua no cartão da sala.
- Ao escolher a tela ou janela, marque **Compartilhar áudio do computador** para incluir os sons do sistema. A captura de áudio do sistema está disponível no Windows; em outros sistemas a opção fica desativada. O áudio do aplicativo também pode ser capturado, então use fones para evitar eco. Se o sistema não entregar uma faixa de áudio, a imagem continua sendo transmitida.
- Em **Configurações → Compartilhamento de tela**, escolha **Desempenho** (720p/15 FPS, padrão), **Equilibrado** (720p/25 FPS) ou **Nitidez** (1080p/30 FPS). A alteração vale imediatamente, inclusive durante uma transmissão. O aplicativo limita a captura e o envio de vídeo para reduzir o uso do processador e da rede. Ao jogar, comece por **Desempenho**; salas com mais participantes exigem mais processamento porque cada pessoa recebe uma cópia via WebRTC.
- O indicador de fala usa o nível do microfone local e o sinal enviado à sala. Se uma pessoa aparecer falando mas o áudio não chegar, verifique a conexão WebRTC e a configuração TURN entre redes diferentes.

### Configurações e foto

Clique na engrenagem ao lado do seu nome para escolher o tema **Claro** ou **Escuro** e a cor de destaque. Você pode usar Violeta, Azul ou Rosa, ou escolher qualquer cor no seletor ou digitando seu código hexadecimal. A alteração aparece imediatamente e fica salva neste dispositivo. Também é possível ajustar o limite local de envio e a foto de perfil. A foto é recortada em 256 × 256 pixels, enviada ao servidor e aparece no chat e nas salas de voz para outras pessoas. Ela fica guardada em `data/profiles.json`, associada à identidade deste dispositivo. Mantenha o volume `orbita-data` ao atualizar o contêiner. Se apagar a identidade local do aplicativo, o perfil anterior não poderá ser editado. As preferências de aparência e tamanho ficam somente neste dispositivo.

### Atualizações do aplicativo

O cliente verifica a Release pública mais recente do repositório `fmarcos8/audio-node-socket-api` a cada abertura. Se a versão for maior que a instalada e houver um instalador para seu sistema, aparece um aviso com o botão **Baixar atualização**; o download abre no navegador e a instalação é feita pelo usuário. Também é possível usar **Configurações → Verificar agora**. Sem internet ou sem Release publicada, o início do aplicativo continua normalmente. Essa atualização é do cliente; o servidor Docker deve ser atualizado separadamente quando houver mudanças nele.

Para publicar a próxima versão Windows, atualize o número em `package.json` e `package-lock.json` (por exemplo, `npm version 0.3.4 --no-git-tag-version`), teste e gere o instalador no Windows com `npm run pack:win`. Envie o código para `main`, crie uma branch de versão no mesmo commit e publique uma **GitHub Release** com tag `v0.3.4`, anexando o `.exe` gerado em `dist/`. O aviso no aplicativo só aparece quando houver uma Release pública com instalador para o sistema instalado.

### Atualizar a instalação

No servidor Docker, substitua os arquivos do projeto mantendo seu `.env` e execute `docker compose up -d --build`. Não exclua o volume `orbita-data`. No Windows, extraia a versão nova do projeto, execute `npm install` e `npm run pack:win`, depois instale o novo `.exe`. **Atualize servidor e cliente** para usar anexos de até 100 MB e foto de perfil.

## Empacotar

```bash
npm run pack:win    # no Windows: instalador NSIS
npm run pack:linux  # no Linux: AppImage
```

Os arquivos gerados vão para `dist/`. É mais simples gerar cada instalador no próprio sistema operacional de destino. O servidor também está incluído no app empacotado; o modo de servidor permanente continua disponível com `npm run server` no projeto fonte.

O ícone do Órbita está em `assets/`: use `orbita-icon.ico` para o instalador Windows, `orbita-icon.png` para outras interfaces e `orbita-icon.svg` quando precisar redimensionar sem perda de qualidade. O `npm run pack:win` já usa o arquivo `.ico` automaticamente.

## Organização

- `electron/`: janela segura, permissões, criação do servidor local e seleção de tela.
- `renderer/`: interface, canais, chat e conexões WebRTC.
- `server/`: autenticação por código, histórico, presença e sinalização.
- `test/`: testes de integração do servidor.

## Verificar

```bash
npm test
```
