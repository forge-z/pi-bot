# Varredura de segredos

O workflow `Secret scan` executa Gitleaks em pushes, pull requests e acionamento manual. O checkout traz o histórico completo da referência; o scanner examina os commits alcançáveis pelo `HEAD` e falha se encontrar um padrão de segredo. A imagem do Gitleaks é fixada por versão e digest no script, e a configuração estende as regras padrão do scanner.

Para executar a mesma verificação localmente, use:

```sh
bash scripts/check-secrets.sh
```

O script precisa do Docker e monta o checkout e os diretórios Git somente para leitura. A saída redige os valores detectados; ela ainda pode indicar regra, arquivo e linha. O workflow não exige segredos configurados no repositório.

`.gitignore` reduz adições acidentais de arquivos locais de ambiente e chaves privadas, mas não protege arquivos que já foram commitados. Se uma credencial real aparecer em uma verificação, trate-a como exposta e siga o procedimento do provedor para revogá-la; apagar o arquivo em um commit posterior não remove o valor do histórico.

O script lê `.gitleaks.toml` na raiz. O Gitleaks também carrega `.gitleaksignore` dessa raiz, sem flag extra. Cada linha é uma impressão digital no formato `commit:arquivo:regra:linha` e ignora só aquele achado; a varredura do histórico continua ativa. O token sintético de `test/job-completion-notify.test.ts` introduzido em `d7da85a` (`generic-api-key`, linha 266) está listado assim. O teste agora usa um placeholder só de letras, que a regra padrão não trata como segredo. O valor antigo permanece no histórico e segue coberto pela impressão.

Uma verificação limpa não prova que não há segredos: o Gitleaks usa regras conhecidas e heurísticas. Atualize a versão e o digest somente após validar a nova imagem oficial e confirmar que uma fixture sintética é detectada.
