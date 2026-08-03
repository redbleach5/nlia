// POST /api/capability/refresh — force re-detect capability profile

import { NextResponse } from 'next/server';
import { detectProfile, TIER_DESCRIPTIONS, getTierParams, resolveAgentTier } from '@/lib/capability-profile';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const profile = await detectProfile();
    if (!profile) {
      return NextResponse.json({
        profile: null,
        error: 'Could not detect profile — is Ollama running?',
      }, { status: 400 });
    }

    const agentTier = resolveAgentTier(profile);
    return NextResponse.json({
      profile,
      tier: profile.tier,
      tierInfo: TIER_DESCRIPTIONS[profile.tier],
      params: getTierParams(profile.tier),
      agentTier,
      agentTierInfo: TIER_DESCRIPTIONS[agentTier],
      agentParams: getTierParams(agentTier),
    });
  } catch (e) {
    logger.error('api', 'failed', {}, e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
