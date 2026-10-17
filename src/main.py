"""
Billiards-solo - offline desktop 8-ball & snooker vs-AI.
Reverse-engineering study of bloob.io, reimplemented in Python/pygame.

This is the initial OFFLINE skeleton: it opens a window, draws a pool-table
outline and a placeholder rack. Real physics, rules, and the vs-AI bot land in
later tasks (see docs/REA_plan.md and the task list). The whole thing runs with
no network access.
"""

import sys

import pygame

# --- Display / world constants (PLACEHOLDER; to be tuned against REA findings) ---
WINDOW_W, WINDOW_H = 1000, 560
TABLE_RECT = pygame.Rect(60, 40, 880, 480)
BALL_RADIUS = 11
FPS = 60

# 16 balls: index 0 = cue (white); 1-7 solids, 8 = black, 9-15 stripes.
BALL_COLORS = [
    (235, 235, 235),  # 0 cue
    (255, 200, 40), (40, 60, 200), (210, 40, 40), (120, 40, 200),
    (200, 120, 30), (40, 160, 60), (150, 40, 40), (20, 20, 20),  # 1-8
    (255, 200, 40), (40, 60, 200), (210, 40, 40), (120, 40, 200),
    (200, 120, 30), (40, 160, 60), (150, 40, 40),  # 9-15 (stripes reuse solid colors)
]


def draw_table(surface: pygame.Surface) -> None:
    surface.fill((30, 30, 34))
    pygame.draw.rect(surface, (20, 90, 40), TABLE_RECT)            # cloth
    pygame.draw.rect(surface, (120, 80, 30), TABLE_RECT.inflate(14, 14), 7)  # rail
    # six pockets
    pocket_positions = [
        (TABLE_RECT.left, TABLE_RECT.top), (TABLE_RECT.centerx, TABLE_RECT.top),
        (TABLE_RECT.right, TABLE_RECT.top), (TABLE_RECT.left, TABLE_RECT.bottom),
        (TABLE_RECT.centerx, TABLE_RECT.bottom), (TABLE_RECT.right, TABLE_RECT.bottom),
    ]
    for px, py in pocket_positions:
        pygame.draw.circle(surface, (10, 10, 10), (px, py), 16)


def draw_balls(surface: pygame.Surface, positions) -> None:
    for idx, (x, y) in enumerate(positions):
        pygame.draw.circle(surface, BALL_COLORS[idx], (int(x), int(y)), BALL_RADIUS)
        pygame.draw.circle(surface, (0, 0, 0), (int(x), int(y)), BALL_RADIUS, 1)


def main() -> None:
    pygame.init()
    screen = pygame.display.set_mode((WINDOW_W, WINDOW_H))
    pygame.display.set_caption("Billiards-solo (offline skeleton)")
    clock = pygame.time.Clock()

    # placeholder spread of balls; replaced by a real rack later
    cx, cy = TABLE_RECT.center
    positions = [(cx, cy)] + [
        (cx + 120 + (i % 4) * 24, cy - 40 + i * 20) for i in range(1, 16)
    ]

    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
        draw_table(screen)
        draw_balls(screen, positions)
        pygame.display.flip()
        clock.tick(FPS)

    pygame.quit()
    sys.exit()


if __name__ == "__main__":
    main()
