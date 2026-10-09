# Portas no cadastro móvel

Complemento do cadastro renovado: portas RTSP e HTTP aparecem no formulário principal. O valor inicial sugerido é 554 para vídeo e 80 para acesso, sem afirmar que foram detectados. Usuário pode alterar os valores ou selecionar Buscar automaticamente para a porta do vídeo. A porta manual não pode ficar vazia; escolher automático não apaga o valor manual anterior.

O servidor existente tenta a porta informada primeiro e pode encontrar outra porta entre os candidatos conhecidos. A confirmação mostra a porta detectada. Não foi adicionado um bloqueio exclusivo de porta no servidor.

ONVIF e caminho do vídeo ficam em Outros dados (opcional), acessíveis antes do teste. Textos repetidos e cartões de explicação foram removidos do formulário principal.

Validação: tipos e testes móveis/manutenção; componente React com adaptadores simulados cobrindo portas manuais 5540/8000, busca automática, volta ao modo manual preservando o valor, campo manual vazio rejeitado e os fluxos anteriores de cadastro/cancelamento/RTMP/cota. Sem APK gerado.
