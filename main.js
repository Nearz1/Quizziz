// ==UserScript==
// @name         Quizizz Wayground X
// @version      52.2
// @description  Solutions Quizizz
// @author       scolver
// @icon         https://tse1.mm.bing.net/th/id/OIP.Ydweh29BuHk_PGD4dGJXbAHaHa?rs=1&pid=ImgDetMain&o=7&rm=3
// @match        https://wayground.com/join/game/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // :: provedor primário — chaves rotativas do Gemini
    const GEMINI_API_KEYS = [
        "CHAVE_GEMINI_1",
        "CHAVE_GEMINI_2",
        "CHAVE_GEMINI_3"
    ];

    // :: provedor secundário — chaves rotativas do OpenRouter
    const OPENROUTER_API_KEYS = [
        "SUA_CHAVE_OPENROUTER_1",
        "SUA_CHAVE_OPENROUTER_2",
        "SUA_CHAVE_OPENROUTER_3"
    ];

    const DEEPSEEK_MODEL_IDENTIFIER = "deepseek/deepseek-chat";
    let activeAiProvider = 'gemini';

    let geminiKeyRotationIndex = 0;
    let openRouterKeyRotationIndex = 0;
    let rawAiResponseCache = '';

    // :: padrão para capturar IDs de quiz nas URLs interceptadas
    const QUIZ_ID_URL_PATTERN = /\/(?:quiz|quizzes|admin\/quiz|games|attempts|join)\/([a-f0-9]{24})/i;
    let detectedQuizId = null;
    let networkInterceptorsActive = false;


    function waitForElement(selector, returnAll = false, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const startTimestamp = Date.now();
            const pollingInterval = setInterval(() => {
                const result = returnAll ? document.querySelectorAll(selector) : document.querySelector(selector);
                if ((returnAll && result.length > 0) || (!returnAll && result)) {
                    clearInterval(pollingInterval);
                    resolve(result);
                } else if (Date.now() - startTimestamp > timeout) {
                    clearInterval(pollingInterval);
                    reject(new Error(`Elemento(s) "${selector}" não encontrado(s) após ${timeout / 1000} segundos.`));
                }
            }, 100);
        });
    }

    function waitForElementToDisappear(selector, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const startTimestamp = Date.now();
            const pollingInterval = setInterval(() => {
                const element = document.querySelector(selector);
                if (!element) {
                    clearInterval(pollingInterval);
                    resolve();
                } else if (Date.now() - startTimestamp > timeout) {
                    clearInterval(pollingInterval);
                    reject(new Error(`Elemento "${selector}" não desapareceu após ${timeout / 1000} segundos.`));
                }
            }, 100);
        });
    }


    async function extractQuestionPayload() {
        try {
            const questionTextNode = document.querySelector('#questionText');
            const questionTextContent = questionTextNode ? questionTextNode.innerText.trim().replace(/\s+/g, ' ') : "Não foi possível encontrar o texto da pergunta.";
            const questionImageNode = document.querySelector('img[data-testid="question-container-image"]');
            const questionImageSrc = questionImageNode ? questionImageNode.src : null;

            const extractOptionText = (el) => {
                const mathAnnotation = el.querySelector('annotation[encoding="application/x-tex"]');
                return mathAnnotation ? mathAnnotation.textContent.trim() : el.querySelector('#optionText')?.innerText.trim() || '';
            };

            const dropdownTriggers = document.querySelectorAll('button.options-dropdown');
            if (dropdownTriggers.length > 1) {
                console.log("Tipo Múltiplos Dropdowns detectado.");
                const dropdownEntries = [];
                let questionMarkupWithPlaceholders = questionTextNode.innerHTML;
                const activePopperSelector = '.v-popper__popper--shown';

                dropdownTriggers.forEach((trigger, idx) => {
                    const placeholder = ` [RESPOSTA ${idx + 1}] `;
                    const wrapperNode = trigger.closest('.dropdown-wrapper');
                    if (wrapperNode) {
                        questionMarkupWithPlaceholders = questionMarkupWithPlaceholders.replace(wrapperNode.outerHTML, placeholder);
                    }
                });

                const tempParserNode = document.createElement('div');
                tempParserNode.innerHTML = questionMarkupWithPlaceholders;
                const sanitizedQuestionText = tempParserNode.innerText.replace(/\s+/g, ' ');

                let sharedOptionPool = [];
                const firstTrigger = dropdownTriggers[0];
                firstTrigger.click();
                try {
                    const poolOptionNodes = await waitForElement(`${activePopperSelector} button.dropdown-option`, true, 2000);
                    sharedOptionPool = Array.from(poolOptionNodes).map(el => el.innerText.trim());
                    console.log("Pool de opções detectado:", sharedOptionPool);
                } catch (poolError) {
                    console.error("Falha ao ler o pool de opções do primeiro dropdown.", poolError);
                    if (document.querySelector(activePopperSelector)) document.body.click();
                }

                if (document.querySelector(activePopperSelector)) document.body.click();
                try {
                    await waitForElementToDisappear(activePopperSelector, 2000);
                } catch (disappearError) {
                    console.warn("Popper não fechou, mas continuando...");
                }

                dropdownTriggers.forEach((trigger, idx) => {
                    dropdownEntries.push({
                        button: trigger,
                        placeholder: `[RESPOSTA ${idx + 1}]`
                    });
                });

                console.log("Texto Limpo Enviado para IA:", sanitizedQuestionText);
                return { questionText: sanitizedQuestionText, questionImageUrl: questionImageSrc, questionType: 'multi_dropdown', dropdowns: dropdownEntries, allAvailableOptions: sharedOptionPool };
            }

            if (dropdownTriggers.length === 1) {
                return { questionText: questionTextContent, questionImageUrl: questionImageSrc, questionType: 'dropdown', dropdownButton: dropdownTriggers[0] };
            }

            const equationEditorNode = document.querySelector('div[data-cy="equation-editor"]');
            if (equationEditorNode) {
                return { questionText: questionTextContent, questionImageUrl: questionImageSrc, questionType: 'equation' };
            }

            // :: detecção de drag-and-drop sobre imagem de fundo
            const imageDropZoneNodes = document.querySelectorAll('.drag-and-drop-image-blank');
            const imageDraggableNodes = document.querySelectorAll('.drag-option-dnd-image');
            if (imageDropZoneNodes.length > 0 && imageDraggableNodes.length > 0) {
                console.log("Tipo Drag and Drop over Image detectado.");
                const backgroundImageNode = document.querySelector('.image-container img');
                const backgroundImageSrc = backgroundImageNode ? backgroundImageNode.src : null;

                const draggableOptionSet = Array.from(imageDraggableNodes).map(el => ({
                    text: el.innerText.trim().replace(/\n/g, ' '),
                    element: el
                }));

                const rawDropZones = Array.from(imageDropZoneNodes).map(el => {
                    const boundingRect = el.getBoundingClientRect();
                    return { element: el, top: boundingRect.top, left: boundingRect.left };
                });

                rawDropZones.sort((a, b) => {
                    if (Math.abs(a.top - b.top) > 20) {
                        return a.top - b.top;
                    }
                    return a.left - b.left;
                });

                const sortedDropZones = rawDropZones.map((entry, idx) => ({
                    id: `ESPAÇO ${idx + 1}`,
                    element: entry.element
                }));

                return { questionText: questionTextContent, questionImageUrl: backgroundImageSrc, questionType: 'drag_and_drop_image', draggableOptions: draggableOptionSet, dropZones: sortedDropZones };
            }

            const blankDropTargets = document.querySelectorAll('button.droppable-blank');
            const draggablePills = document.querySelectorAll('.drag-option');
            if (blankDropTargets.length > 1 && draggablePills.length > 0) {
                const dragDropContainer = document.querySelector('.drag-drop-text > div');
                const resolvedDropZones = [];
                if (dragDropContainer) {
                    const containerChildren = Array.from(dragDropContainer.children);
                    for (let i = 0; i < containerChildren.length; i++) {
                        const blankTrigger = containerChildren[i].querySelector('button.droppable-blank');
                        if (blankTrigger) {
                            const precedingNode = containerChildren[i - 1];
                            if (precedingNode && precedingNode.tagName === 'SPAN') {
                                let extractedPrompt = precedingNode.innerText.trim().replace(/:\s*$/, '').replace(/\s+/g, ' ');
                                resolvedDropZones.push({ prompt: extractedPrompt, blankElement: blankTrigger });
                            }
                        }
                    }
                }
                const draggableLabelSet = Array.from(draggablePills).map(el => ({ text: el.innerText.trim(), element: el }));
                return { questionText: dragDropContainer.innerText.trim(), questionImageUrl: questionImageSrc, questionType: 'multi_drag_into_blank', draggableOptions: draggableLabelSet, dropZones: resolvedDropZones };
            }
            if (blankDropTargets.length === 1 && draggablePills.length > 0) {
                const draggableLabelSet = Array.from(draggablePills).map(el => ({ text: el.querySelector('.dnd-option-text')?.innerText.trim() || '', element: el }));
                return { questionText: questionTextContent, questionImageUrl: questionImageSrc, questionType: 'drag_into_blank', draggableOptions: draggableLabelSet, dropZone: { element: blankDropTargets[0] } };
            }

            // :: classificação por categorias
            const categorizationContainer = document.querySelector('.classification-question, .classification-layout-evaluation-completed, .classification-layout');
            if (categorizationContainer) {
                console.log("Tipo Categorize detectado.");

                const categoryGroupNodes = document.querySelectorAll('.list-group');
                const categoryEntries = Array.from(categoryGroupNodes).map(el => {
                    const titleNode = el.querySelector('.bg-gradient-to-b span, span');
                    return {
                        name: titleNode ? titleNode.innerText.trim() : 'Categoria',
                        element: el
                    };
                });

                const draggableItemSet = [];
                const seenLabelSet = new Set();
                const grabbableNodes = document.querySelectorAll('.cursor-grab, .classification-option-text-container');

                grabbableNodes.forEach(el => {
                    const parentCard = el.closest('.cursor-grab') || el.closest('[id]') || el;
                    const labelText = el.innerText.trim().replace(/\n/g, ' ');
                    if (labelText && !seenLabelSet.has(labelText)) {
                        seenLabelSet.add(labelText);
                        draggableItemSet.push({ text: labelText, element: parentCard });
                    }
                });

                if (categoryEntries.length > 0 && draggableItemSet.length > 0) {
                    return { questionText: questionTextContent, questionImageUrl: questionImageSrc, questionType: 'categorize', categories: categoryEntries, draggables: draggableItemSet };
                }
            }

            const matchLayoutContainer = document.querySelector('.match-order-options-container, .question-options-layout');
            if (matchLayoutContainer) {
                const draggableTileNodes = Array.from(matchLayoutContainer.querySelectorAll('.match-order-option.is-option-tile'));
                const dropTargetTileNodes = Array.from(matchLayoutContainer.querySelectorAll('.match-order-option.is-drop-tile'));

                const hasImageTiles = draggableTileNodes.length > 0 && (draggableTileNodes[0].querySelector('.option-image') || draggableTileNodes[0].dataset.type === 'image');

                if (hasImageTiles) {
                    console.log("Tipo Match-Order (Imagem p/ Texto) detectado.");
                    const imageItemSet = [];
                    for (let i = 0; i < draggableTileNodes.length; i++) {
                        const tileNode = draggableTileNodes[i];
                        const imageDiv = tileNode.querySelector('.option-image');
                        const computedStyle = imageDiv ? window.getComputedStyle(imageDiv).backgroundImage : null;
                        const urlCapture = computedStyle ? computedStyle.match(/url\("(.+?)"\)/) : null;
                        let resolvedImageUrl = urlCapture ? urlCapture[1] : null;

                        if (!resolvedImageUrl) {
                            const dataCyAttr = tileNode.dataset.cy;
                            if (dataCyAttr && dataCyAttr.includes('url(')) {
                                const fallbackCapture = dataCyAttr.match(/url\((.+)\)/);
                                if (fallbackCapture) resolvedImageUrl = fallbackCapture[1].replace(/\?w=\d+&h=\d+$/, '');
                            }
                        }

                        if (resolvedImageUrl) {
                            imageItemSet.push({ id: `IMAGEM ${i + 1}`, imageUrl: resolvedImageUrl, element: tileNode });
                        }
                    }

                    const textTargetSet = dropTargetTileNodes.map(el => ({ text: extractOptionText(el), element: el }));
                    return { questionText: questionTextContent, questionImageUrl: questionImageSrc, questionType: 'match_image_to_text', draggableItems: imageItemSet, dropZones: textTargetSet };

                } else if (draggableTileNodes.length > 0 && dropTargetTileNodes.length > 0) {
                    const labelItemSet = draggableTileNodes.map(el => ({ text: extractOptionText(el), element: el }));
                    const targetItemSet = dropTargetTileNodes.map(el => ({ text: extractOptionText(el), element: el }));

                    const resolvedType = questionTextContent.toLowerCase().includes('reorder') ? 'reorder' : 'match_order';
                    return { questionText: questionTextContent, questionImageUrl: questionImageSrc, questionType: resolvedType, draggableItems: labelItemSet, dropZones: targetItemSet };
                }
            }

            const openEndedInputNode = document.querySelector('textarea[data-cy="open-ended-textarea"]');
            if (openEndedInputNode) {
                return { questionText: questionTextContent, questionImageUrl: questionImageSrc, questionType: 'open_ended', answerElement: openEndedInputNode };
            }

            const selectableOptionNodes = document.querySelectorAll('.option.is-selectable');
            if (selectableOptionNodes.length > 0) {
                const isMultiSelect = Array.from(selectableOptionNodes).some(el => el.classList.contains('is-msq'));
                const parsedOptions = Array.from(selectableOptionNodes).map(el => ({ text: extractOptionText(el), element: el }));
                return { questionText: questionTextContent, questionImageUrl: questionImageSrc, questionType: isMultiSelect ? 'multiple_choice' : 'single_choice', options: parsedOptions };
            }

            console.error("Tipo de questão não reconhecido.");
            return null;
        } catch (extractionError) {
            console.error("Erro ao extrair dados da questão:", extractionError);
            return null;
        }
    }

    async function fetchAiSolution(questionPayload) {
        rawAiResponseCache = '';
        const rawResponseToggleBtn = document.getElementById('view-raw-response-btn');
        if (rawResponseToggleBtn) rawResponseToggleBtn.style.display = 'none';

        let instructionPrompt = "", formattedOptionsBlock = "";
        switch (questionPayload.questionType) {
            case 'drag_and_drop_image':
                instructionPrompt = `Esta é uma questão de arrastar rótulos para áreas específicas de uma imagem. As áreas vazias (ESPAÇOS) na imagem foram ordenadas da sua visão de cima para baixo e da esquerda para a direita. Relacione cada espaço visual com o rótulo correto baseado na anatomia/assunto. Responda no formato EXATO: 'ESPAÇO X -> Nome do Rótulo', com cada par em uma nova linha.`;
                const dndImageLabels = questionPayload.draggableOptions.map(item => `- "${item.text}"`).join('\n');
                const dndImageZones = questionPayload.dropZones.map(item => `- "${item.id}"`).join('\n');
                formattedOptionsBlock = `Rótulos Disponíveis:\n${dndImageLabels}\n\nEspaços na Imagem:\n${dndImageZones}`;
                break;
            case 'categorize':
                instructionPrompt = `Esta é uma questão de categorização. Para cada item listado, forneça a categoria correta no formato EXATO: 'Texto do Item -> Nome da Categoria', com cada par em uma nova linha.`;
                const categoryNameList = questionPayload.categories.map(c => `- "${c.name}"`).join('\n');
                const draggableItemList = questionPayload.draggables.map(i => `- "${i.text}"`).join('\n');
                formattedOptionsBlock = `Categorias Disponíveis:\n${categoryNameList}\n\nItens para Categorizar:\n${draggableItemList}`;
                break;
            case 'multi_dropdown':
                instructionPrompt = `Esta é uma questão com múltiplas lacunas ([RESPOSTA X]). As opções disponíveis são um pool compartilhado e cada opção só pode ser usada uma vez. Determine a resposta correta para CADA placeholder. Responda com cada resposta em uma nova linha, no formato '[RESPOSTA X]: Resposta Correta'. Se algum placeholder não tiver uma resposta lógica no pool (ex: está fora da sequência), omita-o da resposta.`;
                formattedOptionsBlock = "Pool de Opções Disponíveis: " + questionPayload.allAvailableOptions.join(', ');
                break;
            case 'match_image_to_text':
                instructionPrompt = `Esta é uma questão de combinar imagens com seus textos correspondentes. Para cada imagem, forneça o par correto no formato EXATO: 'Texto da Opção -> ID da Imagem' (ex: 90° -> IMAGEM 3), com cada par em uma nova linha.`;
                const textTargetList = questionPayload.dropZones.map(item => `- "${item.text}"`).join('\n');
                formattedOptionsBlock = `Opções de Texto (Locais para Soltar):\n${textTargetList}`;
                break;
            case 'match_order':
                instructionPrompt = `Responda com os pares no formato EXATO: 'Texto do Local para Soltar -> Texto do Item para Arrastar', com cada par em uma nova linha.`;
                const matchDraggables = questionPayload.draggableItems.map(item => `- "${item.text}"`).join('\n');
                const matchDropZones = questionPayload.dropZones.map(item => `- "${item.text}"`).join('\n');
                formattedOptionsBlock = `Itens para Arrastar:\n${matchDraggables}\n\nLocais para Soltar:\n${matchDropZones}`;
                break;
            case 'multi_drag_into_blank': instructionPrompt = `Esta é uma questão de combinar múltiplas sentenças com suas expressões corretas. Responda com os pares no formato EXATO: 'Sentença da pergunta -> Expressão da opção', com cada par em uma nova linha.`; const sentenceList = questionPayload.dropZones.map(item => `- "${item.prompt}"`).join('\n'); const expressionList = questionPayload.draggableOptions.map(item => `- "${item.text}"`).join('\n'); formattedOptionsBlock = `Sentenças:\n${sentenceList}\n\nExpressões (Opções):\n${expressionList}`; break;
            case 'equation': instructionPrompt = `Resolva a seguinte equação ou inequação. Forneça apenas a expressão final simplificada (ex: x = 5, ou y > 3).`; formattedOptionsBlock = `EQUAÇÃO: "${questionPayload.questionText}"`; break;
            case 'dropdown': case 'single_choice': instructionPrompt = `Responda APENAS com o texto exato da ÚNICA alternativa correta.`; formattedOptionsBlock = "OPÇÕES:\n" + questionPayload.options.map(opt => `- "${opt.text}"`).join('\n'); break;
            case 'reorder': instructionPrompt = `A tarefa é: "${questionPayload.questionText}". Forneça a ordem correta listando os textos dos itens, um por linha, do primeiro ao último.`; formattedOptionsBlock = "Itens para ordenar:\n" + questionPayload.draggableItems.map(item => `- "${item.text}"`).join('\n'); break;
            case 'drag_into_blank': instructionPrompt = `Responda APENAS com o texto da ÚNICA opção correta que preenche a lacuna.`; formattedOptionsBlock = "Opções para arrastar:\n" + questionPayload.draggableOptions.map(item => `- "${item.text}"`).join('\n'); break;
            case 'open_ended': instructionPrompt = `Responda APENAS com a palavra ou frase curta que preenche a lacuna.`; break;
            case 'multiple_choice': instructionPrompt = `Responda APENAS com os textos exatos de TODAS as alternativas corretas, separando cada uma em uma NOVA LINHA.`; formattedOptionsBlock = "OPÇÕES:\n" + questionPayload.options.map(opt => `- "${opt.text}"`).join('\n'); break;
        }
        let composedTextPrompt = `${instructionPrompt}\n\n---\nPERGUNTA: "${questionPayload.questionText}"\n---\n${formattedOptionsBlock}`;

        let encodedQuestionImage = null;
        if (questionPayload.questionImageUrl) {
            encodedQuestionImage = await imageUrlToBase64(questionPayload.questionImageUrl);
        }
        const hasImageDraggables = questionPayload.questionType === 'match_image_to_text';

        if (activeAiProvider === 'deepseek' && (encodedQuestionImage || hasImageDraggables)) {
            console.warn("DeepSeek ativo: ignorando imagem(ns) automaticamente.");
            encodedQuestionImage = null;
            if (questionPayload.questionType === 'match_image_to_text') {
                questionPayload.questionType = 'match_order';
                questionPayload.draggableItems = questionPayload.draggableItems.map(item => ({
                    text: item.id,
                    element: item.element
                }));
                instructionPrompt = `Responda com os pares no formato EXATO: 'Texto do Local para Soltar -> ID da Imagem' (ex: 90° -> IMAGEM 3), com cada par em uma nova linha.`;
                const fallbackDraggables = questionPayload.draggableItems.map(item => `- "${item.text}"`).join('\n');
                const fallbackDropZones = questionPayload.dropZones.map(item => `- "${item.text}"`).join('\n');
                formattedOptionsBlock = `Itens para Arrastar (IDs):\n${fallbackDraggables}\n\nLocais para Soltar:\n${fallbackDropZones}`;
                composedTextPrompt = `${instructionPrompt}\n\n---\nPERGUNTA: "${questionPayload.questionText}"\n---\n${formattedOptionsBlock}`;
            }
        }

        try {
            let resolvedAiResponse = null;
            if (activeAiProvider === 'gemini') {
                console.log("Usando Provedor: Gemini");
                let allGeminiKeysFailed = false;
                for (let attemptIndex = 0; attemptIndex < GEMINI_API_KEYS.length; attemptIndex++) {
                    const activeKey = GEMINI_API_KEYS[geminiKeyRotationIndex];
                    if (!activeKey || activeKey.includes("SUA_") || activeKey.length < 30) {
                        console.warn(`Chave de API Gemini #${geminiKeyRotationIndex + 1} parece ser um placeholder. Pulando...`);
                        geminiKeyRotationIndex = (geminiKeyRotationIndex + 1) % GEMINI_API_KEYS.length;
                        continue;
                    }
                    const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${activeKey}`;

                    let promptPartList = [{ text: composedTextPrompt }];

                    if (encodedQuestionImage) {
                        const [imageHeader, imageData] = encodedQuestionImage.split(',');
                        let imageMimeType = imageHeader.match(/:(.*?);/)[1];
                        if (!['image/jpeg', 'image/png', 'image/webp'].includes(imageMimeType)) imageMimeType = 'image/jpeg';
                        promptPartList.push({ inline_data: { mime_type: imageMimeType, data: imageData } });
                    }

                    if (questionPayload.questionType === 'match_image_to_text') {
                        promptPartList.push({ text: "\n\nIMAGENS (Itens para Arrastar):\n" });
                        for (const imageItem of questionPayload.draggableItems) {
                            const encodedItem = await imageUrlToBase64(imageItem.imageUrl);
                            if (encodedItem) {
                                const [itemHeader, itemData] = encodedItem.split(',');
                                let itemMimeType = itemHeader.match(/:(.*?);/)[1];
                                if (!['image/jpeg', 'image/png', 'image/webp'].includes(itemMimeType)) itemMimeType = 'image/jpeg';
                                promptPartList.push({ inline_data: { mime_type: itemMimeType, data: itemData } });
                                promptPartList.push({ text: `- ${imageItem.id}` });
                            }
                        }
                    }

                    try {
                        const apiResponse = await fetchWithTimeout(GEMINI_ENDPOINT, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ contents: [{ parts: promptPartList }] })
                        });
                        if (apiResponse.ok) {
                            const responseBody = await apiResponse.json();
                            resolvedAiResponse = responseBody.candidates[0].content.parts[0].text;
                            console.log(`Sucesso com a Chave API Gemini #${geminiKeyRotationIndex + 1}.`);
                            break;
                        }
                        const errorBody = await apiResponse.json();
                        const errorDetail = errorBody.error?.message || `Erro ${apiResponse.status}`;
                        console.warn(`Chave API Gemini #${geminiKeyRotationIndex + 1} falhou: ${errorDetail}. Tentando a próxima...`);
                        rawAiResponseCache = `Falha na Chave Gemini #${geminiKeyRotationIndex + 1}: ${errorDetail}`;
                    } catch (requestError) {
                        console.warn(`Erro na requisição com a Chave API Gemini #${geminiKeyRotationIndex + 1}: ${requestError.message}. Tentando a próxima...`);
                        rawAiResponseCache = `Falha na Chave Gemini #${geminiKeyRotationIndex + 1}: ${requestError.message}`;
                    }
                    geminiKeyRotationIndex = (geminiKeyRotationIndex + 1) % GEMINI_API_KEYS.length;
                    if (attemptIndex === GEMINI_API_KEYS.length - 1) {
                        allGeminiKeysFailed = true;
                    }
                }
                if (!resolvedAiResponse && allGeminiKeysFailed) {
                    throw new Error("Todas as chaves de API do Gemini falharam.");
                }

            } else if (activeAiProvider === 'deepseek') {
                console.log("Usando Provedor: DeepSeek (via OpenRouter)");
                let allOpenRouterKeysFailed = false;

                for (let attemptIndex = 0; attemptIndex < OPENROUTER_API_KEYS.length; attemptIndex++) {
                    const activeKey = OPENROUTER_API_KEYS[openRouterKeyRotationIndex];
                    if (!activeKey || activeKey.includes("SUA_") || activeKey.length < 30) {
                        console.warn(`Chave OpenRouter #${openRouterKeyRotationIndex + 1} parece ser um placeholder. Pulando...`);
                        openRouterKeyRotationIndex = (openRouterKeyRotationIndex + 1) % OPENROUTER_API_KEYS.length;
                        continue;
                    }

                    const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
                    const requestBody = JSON.stringify({
                        model: DEEPSEEK_MODEL_IDENTIFIER,
                        messages: [ { role: 'user', content: composedTextPrompt } ],
                        max_tokens: 1024
                    });

                    try {
                        const apiResponse = await fetchWithTimeout(OPENROUTER_ENDPOINT, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${activeKey}`,
                                'HTTP-Referer': 'https://github.com/Nearz1',
                                'X-Title': 'Quizizz Bypass Script'
                            },
                            body: requestBody
                        });

                        if (apiResponse.ok) {
                            const responseBody = await apiResponse.json();
                            resolvedAiResponse = responseBody.choices[0].message.content;
                            console.log(`Sucesso com a Chave OpenRouter #${openRouterKeyRotationIndex + 1}.`);
                            break;
                        }

                        const errorBody = await apiResponse.json();
                        const errorDetail = errorBody.error?.message || `Erro ${apiResponse.status}`;
                        console.warn(`Chave OpenRouter #${openRouterKeyRotationIndex + 1} falhou: ${errorDetail}. Tentando a próxima...`);
                        rawAiResponseCache = `Falha na Chave OpenRouter #${openRouterKeyRotationIndex + 1}: ${errorDetail}`;

                    } catch (requestError) {
                        console.warn(`Erro na requisição com a Chave OpenRouter #${openRouterKeyRotationIndex + 1}: ${requestError.message}. Tentando a próxima...`);
                        rawAiResponseCache = `Falha na Chave OpenRouter #${openRouterKeyRotationIndex + 1}: ${requestError.message}`;
                    }

                    openRouterKeyRotationIndex = (openRouterKeyRotationIndex + 1) % OPENROUTER_API_KEYS.length;
                    if (attemptIndex === OPENROUTER_API_KEYS.length - 1) {
                        allOpenRouterKeysFailed = true;
                    }
                }

                if (!resolvedAiResponse && allOpenRouterKeysFailed) {
                    throw new Error("Todas as chaves de API do OpenRouter falharam.");
                }
            }

            console.log("Resposta bruta da IA:", resolvedAiResponse);
            rawAiResponseCache = resolvedAiResponse;
            return resolvedAiResponse;

        } catch (fatalError) {
            console.error(`Falha ao obter resposta da IA (${activeAiProvider}):`, fatalError.message);
            rawAiResponseCache = `Erro: ${fatalError.message}`;
            throw fatalError;
        }
    }


    async function applyAiSolution(aiResponseText, questionPayload) {
        if (!aiResponseText) return;

        const resolveElementAccentColor = (element) => {
            const computedStyle = window.getComputedStyle(element);
            const backgroundGradient = computedStyle.backgroundImage;
            if (backgroundGradient && backgroundGradient.includes('gradient')) {
                const colorCapture = backgroundGradient.match(/rgb\(\d+, \d+, \d+\)/);
                if (colorCapture) return colorCapture[0];
            }
            return computedStyle.backgroundColor || 'rgba(0, 255, 0, 0.5)';
        };

        switch (questionPayload.questionType) {
            case 'drag_and_drop_image':
                const stripDndQuotes = (str) => str.replace(/[`"']/g, '').trim();
                const dndImagePairings = aiResponseText.split('\n').filter(line => line.includes('->')).map(line => {
                    const segments = line.split('->');
                    return segments.length === 2 ? [stripDndQuotes(segments[0]), stripDndQuotes(segments[1])] : null;
                }).filter(Boolean);

                if (dndImagePairings.length === 0) { console.error("Não foi possível extrair pares válidos da resposta da IA para drag and drop na imagem."); return; }

                const dndLabelIndex = new Map(questionPayload.draggableOptions.map(i => [i.text, i.element]));
                const dndZoneIndex = new Map(questionPayload.dropZones.map(i => [i.id, i.element]));

                const dndColorPalette = ['#FFD700', '#00FFFF', '#FF00FF', '#7FFF00', '#FF8C00', '#DA70D6'];
                let dndColorCursor = 0;

                for (const [zoneId, labelText] of dndImagePairings) {
                    let sourceNode = dndLabelIndex.get(labelText);
                    if (!sourceNode) {
                        const partialKey = [...dndLabelIndex.keys()].find(k => k.includes(labelText) || labelText.includes(k));
                        if (partialKey) sourceNode = dndLabelIndex.get(partialKey);
                    }
                    const targetNode = dndZoneIndex.get(zoneId);

                    if (sourceNode && targetNode) {
                        const accentColor = dndColorPalette[dndColorCursor % dndColorPalette.length];
                        const highlightRule = `box-shadow: 0 0 15px 5px ${accentColor}; border-radius: 8px; border: 2px solid ${accentColor} !important;`;
                        sourceNode.style.cssText += highlightRule;

                        targetNode.style.backgroundColor = accentColor;
                        targetNode.style.opacity = '0.9';
                        targetNode.style.boxShadow = `0 0 10px 5px ${accentColor}`;
                        targetNode.style.border = `2px solid #fff`;
                        targetNode.style.zIndex = '100';

                        dndColorCursor++;
                    } else {
                        console.warn(`Par não encontrado na tela: "${zoneId}" -> "${labelText}"`);
                    }
                }
                break;

            case 'categorize':
                const stripCatQuotes = (str) => str.replace(/[`"']/g, '').trim();
                const categorizationPairings = aiResponseText.split('\n').filter(line => line.includes('->')).map(line => {
                    const segments = line.split('->');
                    return segments.length === 2 ? [stripCatQuotes(segments[0]), stripCatQuotes(segments[1])] : null;
                }).filter(Boolean);

                if (categorizationPairings.length === 0) { console.error("Não foi possível extrair pares válidos da resposta da IA para categorização."); return; }

                const draggableNodeIndex = new Map(questionPayload.draggables.map(i => [i.text, i.element]));
                const categoryNodeIndex = new Map(questionPayload.categories.map(i => [i.name, i.element]));

                const categoryColorPalette = ['#FFD700', '#00FFFF', '#FF00FF', '#7FFF00', '#FF8C00', '#DA70D6'];
                const categoryColorAssignment = new Map();
                let categoryColorCursor = 0;

                for (const [itemLabel, categoryName] of categorizationPairings) {
                    let sourceNode = draggableNodeIndex.get(itemLabel);
                    if (!sourceNode) {
                        const partialKey = [...draggableNodeIndex.keys()].find(k => k.includes(itemLabel) || itemLabel.includes(k));
                        if (partialKey) sourceNode = draggableNodeIndex.get(partialKey);
                    }

                    let targetNode = categoryNodeIndex.get(categoryName);
                    if (!targetNode) {
                        const partialCatKey = [...categoryNodeIndex.keys()].find(k => k.includes(categoryName) || categoryName.includes(k));
                        if (partialCatKey) targetNode = categoryNodeIndex.get(partialCatKey);
                    }

                    if (sourceNode && targetNode) {
                        if (!categoryColorAssignment.has(categoryName)) {
                            categoryColorAssignment.set(categoryName, categoryColorPalette[categoryColorCursor % categoryColorPalette.length]);
                            categoryColorCursor++;
                        }
                        const accentColor = categoryColorAssignment.get(categoryName);

                        const highlightRule = `box-shadow: 0 0 15px 5px ${accentColor}; border-radius: 8px; border: 2px solid ${accentColor};`;
                        sourceNode.style.cssText += highlightRule;

                        targetNode.style.border = `2px solid ${accentColor}`;
                        targetNode.style.boxShadow = `inset 0 0 20px ${accentColor}`;
                    } else {
                        console.warn(`Item ou categoria não encontrados: "${itemLabel}" -> "${categoryName}"`);
                    }
                }
                break;

            case 'multi_dropdown':
                const activePopperSelector = '.v-popper__popper--shown';
                const parsedDropdownAnswers = aiResponseText.split('\n').map(line => {
                    const captured = line.match(/\[RESPOSTA (\d+)\]:\s*(.*)/i);
                    if (!captured) return null;
                    return {
                        index: parseInt(captured[1], 10) - 1,
                        answer: captured[2].trim().replace(/["'`]/g, '')
                    };
                }).filter(Boolean);

                const dropdownAnswerIndex = new Map(parsedDropdownAnswers.map(a => [a.index, a.answer]));
                const emptyDropdownLabel = 'Selecionar resposta';

                console.log("FASE 1: Limpando dropdowns com respostas erradas ou desnecessárias...");
                for (let ddIndex = 0; ddIndex < questionPayload.dropdowns.length; ddIndex++) {
                    const dropdownEntry = questionPayload.dropdowns[ddIndex];
                    const currentSelection = dropdownEntry.button.innerText.trim();
                    const expectedAnswer = dropdownAnswerIndex.get(ddIndex);

                    const isAlreadyFilled = currentSelection !== emptyDropdownLabel;
                    const hasExpectedAnswer = !!expectedAnswer;
                    const isWrongSelection = isAlreadyFilled && hasExpectedAnswer && currentSelection !== expectedAnswer;
                    const isUnnecessarySelection = isAlreadyFilled && !hasExpectedAnswer;

                    if (isWrongSelection || isUnnecessarySelection) {
                        console.log(`Limpando Dropdown #${ddIndex + 1} (estava com "${currentSelection}")...`);
                        dropdownEntry.button.click();
                        try {
                            const visibleOptions = await waitForElement(`${activePopperSelector} button.dropdown-option`, true, 2000);
                            const activeOption = Array.from(visibleOptions).find(el => el.innerText.trim() === currentSelection);
                            if (activeOption) {
                                activeOption.click();
                            } else {
                                document.body.click();
                            }
                            await waitForElementToDisappear(activePopperSelector, 2000);
                        } catch (cleanupError) {
                            console.error(`Erro ao tentar limpar Dropdown #${ddIndex + 1}: ${cleanupError.message}`);
                            if (document.querySelector(activePopperSelector)) {
                                document.body.click();
                                try { await waitForElementToDisappear(activePopperSelector, 2000); } catch (innerError) {}
                            }
                        }
                    }
                }

                console.log("FASE 2: Preenchendo respostas corretas da IA...");
                for (const dropdownAnswer of parsedDropdownAnswers) {
                    const dropdownEntry = questionPayload.dropdowns[dropdownAnswer.index];
                    if (!dropdownEntry) {
                        console.error(`Dropdown com índice ${dropdownAnswer.index} não encontrado.`);
                        continue;
                    }
                    const currentSelection = dropdownEntry.button.innerText.trim();
                    if (currentSelection === dropdownAnswer.answer) {
                        continue;
                    }
                    dropdownEntry.button.click();
                    try {
                        const visibleOptions = await waitForElement(`${activePopperSelector} button.dropdown-option`, true, 2000);
                        const matchingOption = Array.from(visibleOptions).find(el => el.innerText.trim() === dropdownAnswer.answer);
                        if (matchingOption) {
                            if (matchingOption.disabled || matchingOption.classList.contains('used-option')) {
                                console.warn(`Opção "${dropdownAnswer.answer}" para Dropdown #${dropdownAnswer.index + 1} ainda está desabilitada.`);
                                document.body.click();
                            } else {
                                matchingOption.click();
                            }
                        } else {
                            console.error(`Opção "${dropdownAnswer.answer}" não encontrada no Dropdown #${dropdownAnswer.index + 1}. (A IA pode ter alucinado)`);
                            document.body.click();
                        }
                        await waitForElementToDisappear(activePopperSelector, 2000);
                    } catch (selectionError) {
                        console.error(`Erro ao tentar selecionar para o dropdown #${dropdownAnswer.index + 1}: ${selectionError.message}`);
                        if (document.querySelector(activePopperSelector)) {
                            document.body.click();
                            try { await waitForElementToDisappear(activePopperSelector, 2000); } catch (innerError) {}
                        }
                    }
                }
                break;

            case 'multi_drag_into_blank':
                const multiDndColorPalette = ['#FFD700', '#00FFFF', '#FF00FF', '#7FFF00', '#FF8C00', '#DA70D6'];
                let multiDndColorCursor = 0;
                const stripMultiDndQuotes = (str) => str.replace(/[`"']/g, '').trim();
                const multiDndPairings = aiResponseText.split('\n').filter(line => line.includes('->')).map(line => {
                    const segments = line.split('->');
                    return segments.length === 2 ? [stripMultiDndQuotes(segments[0]), stripMultiDndQuotes(segments[1])] : null;
                }).filter(Boolean);
                if (multiDndPairings.length === 0) { console.error("Não foi possível extrair pares válidos da resposta da IA."); return; }
                const draggableLabelNodeIndex = new Map(questionPayload.draggableOptions.map(i => [i.text, i.element]));
                const blankZoneNodeIndex = new Map(questionPayload.dropZones.map(i => [i.prompt, i.blankElement]));
                for (const [sentenceFragment, optionLabel] of multiDndPairings) {
                    const closestPromptKey = [...blankZoneNodeIndex.keys()].find(key => key.includes(sentenceFragment) || sentenceFragment.includes(key));
                    const blankNode = blankZoneNodeIndex.get(closestPromptKey);
                    const optionNode = draggableLabelNodeIndex.get(optionLabel);
                    if (blankNode && optionNode) {
                        const accentColor = multiDndColorPalette[multiDndColorCursor % multiDndColorPalette.length];
                        const highlightRule = `box-shadow: 0 0 15px 5px ${accentColor}; border-radius: 4px;`;
                        blankNode.style.cssText = highlightRule;
                        optionNode.style.cssText = highlightRule;
                        multiDndColorCursor++;
                    } else {
                        console.warn(`Par não encontrado no DOM: "${sentenceFragment}" -> "${optionLabel}"`);
                    }
                }
                break;

            case 'equation':
                const EQUATION_KEYPAD_MAP = {
                    '0': 'icon-fas-0', '1': 'icon-fas-1', '2': 'icon-fas-2', '3': 'icon-fas-3', '4': 'icon-fas-4',
                    '5': 'icon-fas-5', '6': 'icon-fas-6', '7': 'icon-fas-7', '8': 'icon-fas-8', '9': 'icon-fas-9',
                    '+': 'icon-fas-plus', '-': 'icon-fas-minus', '*': 'icon-fas-times', '×': 'icon-fas-times',
                    '/': 'icon-fas-divide', '÷': 'icon-fas-divide', '=': 'icon-fas-equals', '.': 'icon-fas-period',
                    '<': 'icon-fas-less-than', '>': 'icon-fas-greater-than',
                    '≤': 'icon-fas-less-than-equal', '≥': 'icon-fas-greater-than-equal',
                    'x': 'icon-fas-variable', 'y': 'icon-fas-variable', 'z': 'icon-fas-variable',
                    '(': 'icon-fas-brackets-round', ')': 'icon-fas-brackets-round',
                    'π': 'icon-fas-pi', 'e': 'icon-fas-euler',
                };
                let normalizedEquationSequence = aiResponseText.trim().replace(/\s/g, '').replace(/<=/g, '≤').replace(/>=/g, '≥');
                console.log(`Digitando a resposta: ${normalizedEquationSequence}`);
                const equationEditorNode = document.querySelector('div[data-cy="equation-editor"]');
                if (equationEditorNode) {
                    equationEditorNode.click();
                    await new Promise(r => setTimeout(r, 100));
                } else {
                    console.error("Não foi possível encontrar o editor de equação para focar.");
                    return;
                }
                for (const character of normalizedEquationSequence) {
                    const keyIconClass = EQUATION_KEYPAD_MAP[character.toLowerCase()];
                    if (keyIconClass) {
                        const iconNode = document.querySelector(`.editor-button i.${keyIconClass}`);
                        if (iconNode) {
                            const keyButton = iconNode.closest('button');
                            if (keyButton) {
                                keyButton.click();
                                await new Promise(r => setTimeout(r, 100));
                            }
                        } else {
                            console.error(`Não foi possível encontrar a tecla para o caractere: "${character}" (ícone: ${keyIconClass})`);
                        }
                    } else {
                        console.error(`Caractere não mapeado no teclado: "${character}"`);
                    }
                }
                break;

            case 'reorder':
                const stripReorderQuotes = (str) => str.replace(/["'`]/g, '').trim();
                const reorderSequence = aiResponseText.split('\n').map(stripReorderQuotes).filter(Boolean);
                const reorderNodeIndex = new Map(questionPayload.draggableItems.map(i => [i.text, i.element]));
                const orderedDropTargets = questionPayload.dropZones;
                if (reorderSequence.length === orderedDropTargets.length) {
                    for (let sequenceIndex = 0; sequenceIndex < reorderSequence.length; sequenceIndex++) {
                        const itemLabel = reorderSequence[sequenceIndex];
                        const sourceNode = reorderNodeIndex.get(itemLabel);
                        const targetNode = orderedDropTargets[sequenceIndex].element;
                        if (sourceNode && targetNode) {
                            const accentColor = resolveElementAccentColor(sourceNode);
                            const highlightRule = `box-shadow: 0 0 15px 5px ${accentColor}; border-radius: 8px;`;
                            sourceNode.style.cssText = highlightRule;
                            targetNode.style.cssText = highlightRule;
                        }
                    }
                }
                break;

            case 'drag_into_blank':
                const cleanedBlankAnswer = aiResponseText.trim().replace(/["'`]/g, '');
                const matchedOption = questionPayload.draggableOptions.find(opt => opt.text === cleanedBlankAnswer);
                if (matchedOption) {
                    const accentColor = resolveElementAccentColor(matchedOption.element);
                    const highlightRule = `box-shadow: 0 0 15px 5px ${accentColor}`;
                    matchedOption.element.style.cssText = highlightRule;
                    questionPayload.dropZone.element.style.cssText = highlightRule;
                }
                break;

            case 'match_image_to_text':
                const matchImgColorPalette = ['#FFD700', '#00FFFF', '#FF00FF', '#7FFF00', '#FF8C00', '#DA70D6'];
                let matchImgColorCursor = 0;
                const stripMatchImgQuotes = (str) => str.replace(/[`"\[\]]/g, '').trim();

                const matchImgPairings = aiResponseText.split('\n').filter(line => line.includes('->')).map(line => {
                    const segments = line.split('->');
                    return segments.length === 2 ? [stripMatchImgQuotes(segments[0]), stripMatchImgQuotes(segments[1])] : null;
                }).filter(Boolean);

                if (matchImgPairings.length === 0) { console.error("Não foi possível extrair pares válidos (Texto -> ID Imagem) da resposta da IA."); return; }

                const imageItemNodeIndex = new Map(questionPayload.draggableItems.map(i => [i.id, i.element]));
                const textTargetNodeIndex = new Map(questionPayload.dropZones.map(i => [i.text, i.element]));

                for (const [segmentA, segmentB] of matchImgPairings) {
                    let sourceNode, targetNode;
                    if (textTargetNodeIndex.has(segmentA) && imageItemNodeIndex.has(segmentB)) {
                        targetNode = textTargetNodeIndex.get(segmentA);
                        sourceNode = imageItemNodeIndex.get(segmentB);
                    } else if (textTargetNodeIndex.has(segmentB) && imageItemNodeIndex.has(segmentA)) {
                        targetNode = textTargetNodeIndex.get(segmentB);
                        sourceNode = imageItemNodeIndex.get(segmentA);
                    } else {
                        console.warn(`Par não mapeado: "${segmentA}" (existe? ${textTargetNodeIndex.has(segmentA)}) -> "${segmentB}" (existe? ${imageItemNodeIndex.has(segmentB)})`);
                        continue;
                    }

                    if (sourceNode && targetNode) {
                        const accentColor = matchImgColorPalette[matchImgColorCursor % matchImgColorPalette.length];
                        const highlightRule = `box-shadow: 0 0 15px 5px ${accentColor}; border-radius: 8px;`;
                        sourceNode.style.cssText = highlightRule;
                        targetNode.style.cssText = highlightRule;
                        matchImgColorCursor++;
                    }
                }
                break;

            case 'match_order':
                const stripMatchQuotes = (str) => str.replace(/[`"']/g, '').trim();
                const matchOrderPairings = aiResponseText.split('\n').filter(line => line.includes('->')).map(line => {
                    const segments = line.split('->');
                    return segments.length === 2 ? [stripMatchQuotes(segments[0]), stripMatchQuotes(segments[1])] : null;
                }).filter(Boolean);
                if (matchOrderPairings.length === 0) { console.error("Não foi possível extrair pares válidos da resposta da IA."); return; }
                const draggableTileIndex = new Map(questionPayload.draggableItems.map(i => [i.text, i.element]));
                const dropTargetIndex = new Map(questionPayload.dropZones.map(i => [i.text, i.element]));
                for (const [segmentA, segmentB] of matchOrderPairings) {
                    let sourceNode, targetNode;
                    if (dropTargetIndex.has(segmentA) && draggableTileIndex.has(segmentB)) {
                        targetNode = dropTargetIndex.get(segmentA);
                        sourceNode = draggableTileIndex.get(segmentB);
                    } else if (dropTargetIndex.has(segmentB) && draggableTileIndex.has(segmentA)) {
                        targetNode = dropTargetIndex.get(segmentB);
                        sourceNode = draggableTileIndex.get(segmentA);
                    } else { continue; }
                    if (sourceNode && targetNode) {
                        const accentColor = resolveElementAccentColor(sourceNode);
                        const highlightRule = `box-shadow: 0 0 15px 5px ${accentColor}; border-radius: 8px;`;
                        sourceNode.style.cssText = highlightRule;
                        targetNode.style.cssText = highlightRule;
                    }
                }
                break;

            default:
                const normalizeText = (str) => {
                    if (typeof str !== 'string') return '';
                    let sanitized = str.replace(/[^a-zA-Z\u00C0-\u017F0-9\s²³]/g, '').replace(/\s+/g, ' ');
                    return sanitized.trim().toLowerCase();
                };

                if (questionPayload.questionType === 'open_ended') {
                    await new Promise(resolve => {
                        questionPayload.answerElement.focus();
                        questionPayload.answerElement.value = aiResponseText.trim();
                        questionPayload.answerElement.dispatchEvent(new Event('input', { bubbles: true }));
                        setTimeout(resolve, 100);
                    });
                    setTimeout(() => document.querySelector('.submit-button-wrapper button, button.submit-btn')?.click(), 500);
                } else if (questionPayload.questionType === 'multiple_choice') {
                    const normalizedAnswerSet = aiResponseText.split('\n').map(normalizeText).filter(Boolean);
                    questionPayload.options.forEach(opt => {
                        if (normalizedAnswerSet.includes(normalizeText(opt.text))) {
                            opt.element.style.border = '5px solid #00FF00';
                            opt.element.click();
                        }
                    });
                } else if (questionPayload.questionType === 'single_choice') {
                    const normalizedSingleAnswer = normalizeText(aiResponseText);
                    const closestOptionMatch = questionPayload.options.find(opt => {
                        const normalizedOption = normalizeText(opt.text);
                        return normalizedOption === normalizedSingleAnswer;
                    });

                    if (closestOptionMatch) {
                        console.log("Correspondência encontrada!", closestOptionMatch.element);
                        closestOptionMatch.element.style.border = '5px solid #00FF00';
                        closestOptionMatch.element.click();
                    } else {
                        console.warn("Nenhuma correspondência exata encontrada após normalização.");
                    }
                }
                break;
        }
    }

    async function triggerQuestionSolver() {
        const solverButton = document.getElementById('ai-solver-button');
        solverButton.disabled = true;
        solverButton.innerText = "Pensando...";
        solverButton.style.transform = 'scale(0.95)';
        solverButton.style.boxShadow = '0 0 0 rgba(0,0,0,0)';
        try {
            const questionPayload = await extractQuestionPayload();
            if (!questionPayload) {
                alert("Não foi possível extrair os dados da questão.");
                return;
            }

            if (questionPayload.questionType === 'multi_dropdown') {
                console.log("Usando IA para resolver múltiplos dropdowns (lógica de pool)...");
                const aiSolution = await fetchAiSolution(questionPayload);
                if (aiSolution) {
                    await applyAiSolution(aiSolution, questionPayload);
                }
            } else if (questionPayload.questionType === 'dropdown') {
                console.log("Iniciando fluxo otimizado para Dropdown...");
                questionPayload.dropdownButton.click();
                try {
                    const visibleOptionNodes = await waitForElement('.v-popper__popper--shown button.dropdown-option', true);
                    questionPayload.options = Array.from(visibleOptionNodes).map(el => ({ text: el.innerText.trim() }));
                    const aiSolution = await fetchAiSolution(questionPayload);
                    if (aiSolution) {
                        const sanitizedDropdownAnswer = aiSolution.trim().replace(/["'`]/g, '');
                        const matchingDropdownOption = Array.from(visibleOptionNodes).find(el => el.innerText.trim() === sanitizedDropdownAnswer);
                        if (matchingDropdownOption) {
                            matchingDropdownOption.click();
                        } else {
                            console.error(`Não foi possível encontrar a opção dropdown com o texto: "${sanitizedDropdownAnswer}"`);
                            document.body.click();
                        }
                    } else {
                        document.body.click();
                    }
                } catch (dropdownError) {
                    console.error("Falha ao processar o dropdown:", dropdownError.message);
                    document.body.click();
                }
            } else {
                const isLatexMathQuestion = questionPayload.options && questionPayload.options.length > 0 && (questionPayload.options[0].text.includes('\\') || questionPayload.questionText.toLowerCase().includes('value of'));
                const mathValueCapture = questionPayload.questionText.match(/value of ([\d.]+)/i);
                if (isLatexMathQuestion && mathValueCapture) {
                    console.log("Questão de matemática detectada. Resolvendo localmente...");
                    const targetNumericValue = parseFloat(mathValueCapture[1]);
                    questionPayload.options.forEach(option => {
                        const evaluableExpression = (() => {
                            let expr = option.text.replace(/\\left/g, '').replace(/\\right/g, '').replace(/\\div/g, '/').replace(/\\times/g, '*').replace(/\\ /g, '').replace(/(\d+)\s*\(/g, '$1 * (').replace(/\)\s*(\d+)/g, ') * $1');
                            expr = expr.replace(/(\d+)\\frac\{(\d+)\}\{(\d+)\}/g, '($1+$2/$3)');
                            expr = expr.replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '($1/$2)');
                            return expr;
                        })();
                        const evaluationResult = (() => { try { return new Function('return ' + evaluableExpression)(); } catch (e) { return null; } })();
                        if (evaluationResult !== null && Math.abs(evaluationResult - targetNumericValue) < 0.001) {
                            option.element.style.border = '5px solid #00FF00';
                            option.element.click();
                        }
                    });
                } else {
                    console.log("Usando IA para resolver...");
                    const aiSolution = await fetchAiSolution(questionPayload);
                    if (aiSolution) {
                        await applyAiSolution(aiSolution, questionPayload);
                    }
                }
            }
        } catch (unexpectedError) {
            console.error("Um erro inesperado ocorreu no fluxo principal:", unexpectedError);
            if (unexpectedError.message && !unexpectedError.message.includes("Ação cancelada")) {
                alert("Ocorreu um erro: " + unexpectedError.message);
            }
        } finally {
            const rawResponseToggleBtn = document.getElementById('view-raw-response-btn');
            if (rawResponseToggleBtn && rawAiResponseCache) {
                rawResponseToggleBtn.style.display = 'block';
            }
            solverButton.disabled = false;
            solverButton.innerText = "✨ Resolver";
            solverButton.style.transform = 'scale(1)';
            solverButton.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.2)';
        }
    }


    function renderDeepSeekImageWarningModal() {
        return new Promise((resolve, reject) => {
            const existingModal = document.getElementById('deepseek-warning-modal');
            if (existingModal) existingModal.remove();

            const overlayNode = document.createElement('div');
            overlayNode.id = 'deepseek-warning-modal';
            Object.assign(overlayNode.style, {
                position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
                backgroundColor: 'rgba(0, 0, 0, 0.6)', zIndex: '2147483648',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'opacity 0.2s ease', opacity: '0'
            });

            const modalContentNode = document.createElement('div');
            Object.assign(modalContentNode.style, {
                background: 'rgba(26, 27, 30, 0.9)', backdropFilter: 'blur(10px)',
                padding: '24px', borderRadius: '16px', color: 'white',
                fontFamily: 'system-ui, sans-serif', maxWidth: '400px',
                textAlign: 'center', boxShadow: '0 10px 40px rgba(0, 0, 0, 0.5)',
                border: '1px solid rgba(255, 255, 255, 0.1)'
            });

            const modalTitle = document.createElement('h3');
            modalTitle.innerText = '⚠️ DeepSeek Não Vê Imagens';
            Object.assign(modalTitle.style, {
                margin: '0 0 12px 0', fontSize: '18px', fontWeight: '600'
            });

            const modalDescription = document.createElement('p');
            modalDescription.innerText = 'Esta pergunta contém uma ou mais imagens que o DeepSeek não pode processar. O que você deseja fazer?';
            Object.assign(modalDescription.style, {
                margin: '0 0 20px 0', fontSize: '14px', lineHeight: '1.5',
                color: 'rgba(255, 255, 255, 0.8)'
            });

            const actionButtonGroup = document.createElement('div');
            Object.assign(actionButtonGroup.style, {
                display: 'flex', flexDirection: 'column', gap: '10px'
            });

            const dismissModal = () => {
                overlayNode.style.opacity = '0';
                setTimeout(() => overlayNode.remove(), 200);
            };

            const switchToGeminiBtn = document.createElement('button');
            switchToGeminiBtn.innerText = 'Usar a Gemini (Recomendado)';
            Object.assign(switchToGeminiBtn.style, {
                background: 'linear-gradient(135deg, #a78bfa 0%, #8b5cf6 100%)',
                border: 'none', borderRadius: '8px', color: 'white', cursor: 'pointer',
                fontSize: '14px', fontWeight: '500', padding: '12px',
                transition: 'all 0.2s ease'
            });
            switchToGeminiBtn.onmouseover = () => switchToGeminiBtn.style.opacity = '0.9';
            switchToGeminiBtn.onmouseout = () => switchToGeminiBtn.style.opacity = '1';
            switchToGeminiBtn.onclick = () => {
                dismissModal();
                resolve('gemini');
            };

            const proceedWithoutImageBtn = document.createElement('button');
            proceedWithoutImageBtn.innerText = 'Responder sem enviar Imagem';
            Object.assign(proceedWithoutImageBtn.style, {
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderRadius: '8px', color: 'rgba(255, 255, 255, 0.8)',
                cursor: 'pointer', fontSize: '14px', fontWeight: '500',
                padding: '12px', transition: 'all 0.2s ease'
            });
            proceedWithoutImageBtn.onmouseover = () => proceedWithoutImageBtn.style.background = 'rgba(255, 255, 255, 0.15)';
            proceedWithoutImageBtn.onmouseout = () => proceedWithoutImageBtn.style.background = 'rgba(255, 255, 255, 0.1)';
            proceedWithoutImageBtn.onclick = () => {
                dismissModal();
                resolve('sem_imagem');
            };

            overlayNode.onclick = (e) => {
                if (e.target === overlayNode) {
                    dismissModal();
                    reject(new Error('Ação cancelada.'));
                }
            };

            actionButtonGroup.appendChild(switchToGeminiBtn);
            actionButtonGroup.appendChild(proceedWithoutImageBtn);
            modalContentNode.appendChild(modalTitle);
            modalContentNode.appendChild(modalDescription);
            modalContentNode.appendChild(actionButtonGroup);
            overlayNode.appendChild(modalContentNode);
            document.body.appendChild(overlayNode);

            setTimeout(() => overlayNode.style.opacity = '1', 10);
        });
    }

    function enablePanelDragBehavior(panelNode, dragHandleNode) {
        let dragOffsetX = 0, dragOffsetY = 0, isDragActive = false;

        dragHandleNode.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.closest('a')) return;

            isDragActive = true;
            const boundingRect = panelNode.getBoundingClientRect();

            if (panelNode.style.bottom || panelNode.style.right) {
                panelNode.style.right = 'auto';
                panelNode.style.bottom = 'auto';
                panelNode.style.top = boundingRect.top + 'px';
                panelNode.style.left = boundingRect.left + 'px';
            }

            dragOffsetX = e.clientX - panelNode.getBoundingClientRect().left;
            dragOffsetY = e.clientY - panelNode.getBoundingClientRect().top;

            panelNode.style.transition = 'none';
            dragHandleNode.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragActive) return;

            let nextX = e.clientX - dragOffsetX;
            let nextY = e.clientY - dragOffsetY;

            nextX = Math.max(0, Math.min(nextX, window.innerWidth - panelNode.offsetWidth));
            nextY = Math.max(0, Math.min(nextY, window.innerHeight - panelNode.offsetHeight));

            panelNode.style.top = nextY + 'px';
            panelNode.style.left = nextX + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragActive) return;
            isDragActive = false;
            panelNode.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
            dragHandleNode.style.cursor = 'default';
        });
    }

    function mountFloatingControlPanel() {
        if (document.getElementById('scolver-floating-panel')) return;
        const panelNode = document.createElement('div');
        panelNode.id = 'scolver-floating-panel';
        Object.assign(panelNode.style, {
            position: 'fixed', bottom: '60px', right: '20px', zIndex: '2147483647',
            display: 'flex', flexDirection: 'column', alignItems: 'stretch',
            gap: '10px', padding: '12px', backgroundColor: 'rgba(26, 27, 30, 0.7)',
            backdropFilter: 'blur(8px)', webkitBackdropFilter: 'blur(8px)', borderRadius: '16px',
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)',
            transition: 'transform 0.3s ease-out, opacity 0.3s ease-out',
            transform: 'translateY(20px)', opacity: '0',
            cursor: 'default'
        });

        const rawResponseViewerNode = document.createElement('div');
        rawResponseViewerNode.id = 'ai-response-viewer';
        Object.assign(rawResponseViewerNode.style, {
            display: 'none', position: 'absolute', bottom: 'calc(100% + 10px)', right: '0',
            width: '300px', maxHeight: '200px', overflowY: 'auto',
            background: 'rgba(10, 10, 15, 0.9)', backdropFilter: 'blur(5px)',
            borderRadius: '8px', border: '1px solid rgba(255, 255, 255, 0.2)',
            padding: '12px', color: '#f0f0f0', fontSize: '12px',
            fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)',
            textAlign: 'left'
        });
        panelNode.appendChild(rawResponseViewerNode);

        const rawResponseToggleBtn = document.createElement('button');
        rawResponseToggleBtn.id = 'view-raw-response-btn';
        Object.assign(rawResponseToggleBtn.style, {
            background: 'none', border: '1px solid rgba(255, 255, 255, 0.2)',
            color: 'rgba(255, 255, 255, 0.6)', cursor: 'pointer',
            fontSize: '11px', padding: '4px 8px', borderRadius: '6px',
            display: 'none', transition: 'all 0.2s ease',
            marginBottom: '4px'
        });
        rawResponseToggleBtn.innerText = 'Ver Resposta da IA';
        rawResponseToggleBtn.addEventListener('click', () => {
            if (rawResponseViewerNode.style.display === 'block') {
                rawResponseViewerNode.style.display = 'none';
            } else {
                rawResponseViewerNode.innerText = rawAiResponseCache || "Nenhuma resposta da IA foi recebida ainda.";
                rawResponseViewerNode.style.display = 'block';
            }
        });
        panelNode.appendChild(rawResponseToggleBtn);

        const panelVisibilityToggleBtn = document.createElement('button');
        panelVisibilityToggleBtn.id = 'toggle-ui-btn';
        panelVisibilityToggleBtn.innerText = 'Ocultar';
        Object.assign(panelVisibilityToggleBtn.style, {
            background: 'none', border: '1px solid rgba(255, 255, 255, 0.2)',
            color: 'rgba(255, 255, 255, 0.6)', cursor: 'pointer',
            fontSize: '11px', padding: '4px 8px', borderRadius: '6px',
            transition: 'all 0.2s ease',
            marginBottom: '4px'
        });
        panelNode.appendChild(panelVisibilityToggleBtn);

        const providerToggleBtn = document.createElement('button');
        providerToggleBtn.id = 'ai-toggle-btn';
        providerToggleBtn.innerText = 'IA: Gemini';
        Object.assign(providerToggleBtn.style, {
            background: 'none', border: '1px solid rgba(255, 255, 255, 0.2)',
            color: 'rgba(255, 255, 255, 0.6)', cursor: 'pointer',
            fontSize: '11px', padding: '4px 8px', borderRadius: '6px',
            transition: 'all 0.2s ease',
            marginBottom: '4px'
        });
        providerToggleBtn.addEventListener('click', () => {
            if (activeAiProvider === 'gemini') {
                activeAiProvider = 'deepseek';
                providerToggleBtn.innerText = 'IA: DeepSeek';
                providerToggleBtn.style.color = '#a78bfa';
            } else {
                activeAiProvider = 'gemini';
                providerToggleBtn.innerText = 'IA: Gemini';
                providerToggleBtn.style.color = 'rgba(255, 255, 255, 0.6)';
            }
            console.log(`Provedor de IA alterado para: ${activeAiProvider}`);
        });
        panelNode.appendChild(providerToggleBtn);

        const solverActionBtn = document.createElement('button');
        solverActionBtn.id = 'ai-solver-button';
        solverActionBtn.innerHTML = '✨ Resolver';
        Object.assign(solverActionBtn.style, {
            background: 'linear-gradient(135deg, #a78bfa 0%, #8b5cf6 100%)',
            border: 'none', borderRadius: '10px', color: 'white', cursor: 'pointer',
            fontFamily: 'system-ui, sans-serif', fontSize: '15px', fontWeight: '600',
            padding: '10px 20px', boxShadow: '0 4px 10px rgba(0, 0, 0, 0.2)',
            transition: 'all 0.2s ease', letterSpacing: '0.5px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px'
        });
        solverActionBtn.addEventListener('mouseover', () => { solverActionBtn.style.transform = 'translateY(-2px)'; solverActionBtn.style.boxShadow = '0 6px 15px rgba(0, 0, 0, 0.3)'; });
        solverActionBtn.addEventListener('mouseout', () => { solverActionBtn.style.transform = 'translateY(0)'; solverActionBtn.style.boxShadow = '0 4px 10px rgba(0, 0, 0, 0.2)'; });
        solverActionBtn.addEventListener('mousedown', () => { solverActionBtn.style.transform = 'translateY(1px)'; solverActionBtn.style.boxShadow = '0 2px 5px rgba(0, 0, 0, 0.15)'; });
        solverActionBtn.addEventListener('mouseup', () => { solverActionBtn.style.transform = 'translateY(-2px)'; solverActionBtn.style.boxShadow = '0 6px 15px rgba(0, 0, 0, 0.3)'; });
        solverActionBtn.addEventListener('click', triggerQuestionSolver);
        panelNode.appendChild(solverActionBtn);

        const brandingFooterNode = document.createElement('div');
        brandingFooterNode.id = 'scolver-watermark';
        const githubSvgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 3c-.58.0-1.25.27-2 1.5c-2.2.86-4.5 1.3-7 1.3-2.5 0-4.7-.44-7-1.3-.75-1.23-1.42-1.5-2-1.5A5.07 5.07 0 0 0 4 4.77 5.44 5.44 0 0 0 2 10.71c0 6.13 3.49 7.34 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>`;
        const instagramSvgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"></rect><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"></path><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"></line></svg>`;
        brandingFooterNode.innerHTML = `
            <div style="display: flex; gap: 8px; align-items: center; color: rgba(255,255,255,0.7); margin-top: 8px; justify-content: flex-end;">
                <span style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size: 13px; font-weight: 400;">@scolver</span>
                <a href="https://github.com/scolver" target="_blank" title="GitHub" style="line-height: 0; color: inherit; transition: color 0.2s ease;">${githubSvgIcon}</a>
                <a href="httpsa://instagram.com/jairmessiasbolsonaro" target="_blank" title="Instagram" style="line-height: 0; color: inherit; transition: color 0.2s ease;">${instagramSvgIcon}</a>
            </div>
        `;
        brandingFooterNode.querySelectorAll('a').forEach(linkNode => {
            linkNode.addEventListener('mouseover', () => linkNode.style.color = 'white');
            linkNode.addEventListener('mouseout', () => linkNode.style.color = 'rgba(255,255,255,0.7)');
        });
        panelNode.appendChild(brandingFooterNode);
        document.body.appendChild(panelNode);

        const toggleableElementIds = [
            'view-raw-response-btn',
            'ai-toggle-btn',
            'ai-solver-button',
            'scolver-watermark'
        ];

        panelVisibilityToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isPanelCollapsed = panelVisibilityToggleBtn.innerText === 'Mostrar';
            panelVisibilityToggleBtn.innerText = isPanelCollapsed ? 'Ocultar' : 'Mostrar';

            toggleableElementIds.forEach(elementId => {
                const targetNode = document.getElementById(elementId);
                if (targetNode) {
                    targetNode.style.display = isPanelCollapsed ? '' : 'none';
                }
            });

            if (isPanelCollapsed && !rawAiResponseCache) {
                document.getElementById('view-raw-response-btn').style.display = 'none';
            }
        });

        enablePanelDragBehavior(panelNode, panelNode);

        setTimeout(() => {
            panelNode.style.transform = 'translateY(0)';
            panelNode.style.opacity = '1';
        }, 100);
        console.log("Floating Panel do resolvedor v52.1 criado com sucesso!");
    }


    function registerQuizId(id, detectionSource) {
        if (id === detectedQuizId) {
            return;
        }
        detectedQuizId = id;
        console.log(`[Quizizz Bypass] Novo Quiz ID detectado (${detectionSource}): %c${id}`, "color: #00FF00; font-weight: bold;");
    }

    function extractQuizIdFromCurrentUrl() {
        const urlMatch = window.location.pathname.match(QUIZ_ID_URL_PATTERN);
        return urlMatch ? urlMatch[1] : null;
    }

    function patchFetchForQuizIdCapture() {
        const nativeFetch = window.fetch;
        window.fetch = async function (...args) {
            const [requestResource] = args;
            if (typeof requestResource === 'string') {
                const urlMatch = requestResource.match(QUIZ_ID_URL_PATTERN);
                if (urlMatch) {
                    const capturedId = urlMatch[1];
                    registerQuizId(capturedId, "fetch");
                }
            }
            return nativeFetch.apply(this, args);
        };
    }

    function patchXhrForQuizIdCapture() {
        const nativeXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url) {
            if (typeof url === 'string') {
                const urlMatch = url.match(QUIZ_ID_URL_PATTERN);
                if (urlMatch) {
                    const capturedId = urlMatch[1];
                    registerQuizId(capturedId, "XHR");
                }
            }
            return nativeXhrOpen.apply(this, arguments);
        };
    }

    function bootstrapQuizIdDetector() {
        console.log("[Quizizz Bypass] Detector de Quiz ID carregado.");
        const detectedFromUrl = extractQuizIdFromCurrentUrl();
        if (detectedFromUrl) {
            registerQuizId(detectedFromUrl, "URL");
        }

        if (!networkInterceptorsActive) {
            console.log("[Quizizz Bypass] Iniciando interceptadores de rede (fetch/XHR).");
            patchFetchForQuizIdCapture();
            patchXhrForQuizIdCapture();
            networkInterceptorsActive = true;
        }
    }

    (function monitorSpaNavigation() {
        const nativePushState = history.pushState;
        history.pushState = function () {
            const navigationResult = nativePushState.apply(this, arguments);
            setTimeout(bootstrapQuizIdDetector, 300);
            return navigationResult;
        };
        window.addEventListener("popstate", () => setTimeout(bootstrapQuizIdDetector, 300));
    })();


    async function fetchWithTimeout(resourceUrl, fetchOptions = {}, timeoutMs = 15000) {
        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
        try {
            const fetchResponse = await fetch(resourceUrl, { ...fetchOptions, signal: abortController.signal });
            clearTimeout(timeoutHandle);
            return fetchResponse;
        } catch (fetchError) {
            clearTimeout(timeoutHandle);
            if (fetchError.name === 'AbortError') throw new Error('A requisição demorou muito e foi cancelada (Timeout).');
            throw fetchError;
        }
    }

    async function imageUrlToBase64(imageUrl) {
        try {
            const cacheBustedUrl = new URL(imageUrl);
            cacheBustedUrl.searchParams.set('_t', new Date().getTime());

            const fetchResponse = await fetchWithTimeout(cacheBustedUrl.href, { cache: 'no-store' });
            const imageBlob = await fetchResponse.blob();
            return new Promise((resolve, reject) => {
                const fileReader = new FileReader();
                fileReader.onloadend = () => resolve(fileReader.result);
                fileReader.onerror = (readerError) => {
                    console.error("Erro no FileReader:", readerError);
                    reject(readerError);
                };
                fileReader.readAsDataURL(imageBlob);
            });
        } catch (conversionError) {
            console.error(`Erro ao converter imagem: ${conversionError.message}`, imageUrl);
            return null;
        }
    }

    setTimeout(mountFloatingControlPanel, 2000);
    bootstrapQuizIdDetector();

})();