import { NextRequest, NextResponse } from 'next/server'
import { readBoard, readLeaderboard } from '@/lib/leaderboard'
import { WEIGHT_CLASSES, type WeightClassId } from '@/lib/stats'

/**
 * GET /api/leaderboard?limit=10[&class=musza]
 *
 * Ranking per kontrakt, osobna lista dla każdej kategorii wagowej. Bez
 * parametru `class` schodzi wszystkie pięć list.
 *
 * Pozycja na liście to liczba wygranych walk i nic więcej — nie jest oceną
 * tokena ani prognozą (CLAUDE.md § Czego nie robić).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const limitParam = searchParams.get('limit')
  const classParam = searchParams.get('class')

  const limit = limitParam === null ? 10 : Number(limitParam)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json(
      { error: 'Parametr `limit` musi być liczbą całkowitą z przedziału 1–100.' },
      { status: 400 },
    )
  }

  if (classParam !== null && !WEIGHT_CLASSES.some((c) => c.id === classParam)) {
    return NextResponse.json(
      {
        error:
          'Nieznana kategoria wagowa. Dozwolone: ' +
          WEIGHT_CLASSES.map((c) => c.id).join(', ') +
          '.',
      },
      { status: 400 },
    )
  }

  try {
    if (classParam !== null) {
      const board = await readBoard(classParam as WeightClassId, limit)
      return NextResponse.json({ boards: [board] })
    }
    return NextResponse.json(await readLeaderboard(limit))
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 },
    )
  }
}
