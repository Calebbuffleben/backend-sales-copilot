/** Shared wrapper so a layperson never writes JSON. Python uses the same layout. */

export function compileSpecialistPrompt(input: {
  name: string;
  description: string;
  instructions: string;
  tone?: string;
  exampleMessage?: string;
  transcript: string;
  hostContext?: string;
  conversationStateJson?: string;
}): string {
  const tone = (input.tone || 'direto, curto, acionável').trim();
  const example = (input.exampleMessage || '').trim();
  return [
    `Você é o especialista "${input.name}" em uma conversa de vendas ao vivo.`,
    `O que observa: ${input.description || input.instructions}`,
    input.instructions ? `Instruções: ${input.instructions}` : '',
    `Tom: ${tone}.`,
    example ? `Exemplo de mensagem boa: ${example}` : '',
    'Use SOMENTE a evidência. Não invente fatos. Não fale com o cliente.',
    'Retorne JSON puro com exatamente:',
    'source_turn_id (string), secondary_feedback (string curta ou ""),',
    'secondary_feedback_type (risk|objection|clarification),',
    'confidence (número 0..1), evidence_text (citação literal curta),',
    'next_turn_hint (string, dica para o próximo turno ou "").',
    '',
    `evidencia=${input.transcript.slice(0, 2000)}`,
    `contexto_host=${(input.hostContext || '').slice(0, 1500)}`,
    `estado=${input.conversationStateJson || '{}'}`,
  ]
    .filter(Boolean)
    .join('\n');
}
