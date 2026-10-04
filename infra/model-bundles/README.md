# Modelo de objetos de produção

O pacote contém somente os arquivos OpenVINO de YOLO26n INT8 já usados e
comparados na Vibe: entradas fixas 416, 512 e 640. Não contém gravações,
imagens de clientes, senhas ou modelos alternativos.

SHA-256: `141483cf8952235870f465af74f419cba1b4a3e42a99ecbb5294fc7e51d2392d`.

O instalador verifica o pacote, instala sem rede e recusa substituir um modelo
existente diferente silenciosamente. A presença do modelo não ativa câmeras
nem altera permissões do plano. A variante antiga sem tamanho no nome não é
necessária: o detector seleciona primeiro as variantes explícitas.
