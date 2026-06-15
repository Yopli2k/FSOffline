<?php
/**
 * This file is part of FSOffline plugin for FacturaScripts.
 * FacturaScripts Copyright (C) 2015-2026 Carlos Garcia Gomez <carlos@facturascripts.com>
 * FSOffline      Copyright (C) 2026-2026 Jose Antonio Cuello Principal <yopli2000@gmail.com>
 *
 * This program and its files are under the terms of the license specified in the LICENSE file.
 */

namespace FacturaScripts\Plugins\FSOffline\Controller;

use FacturaScripts\Core\Contract\ControllerInterface;
use FacturaScripts\Core\Response;

/**
 * Bare reachability endpoint used by FSOffline.Connection to detect whether the
 * server is alive (the online/offline recovery ping).
 *
 * It deliberately implements ControllerInterface directly instead of extending
 * Controller or ApiController: it must NOT load the user session, templates or
 * the API token logic. It only answers a 204 with no body, as cheap as possible.
 *
 * It also NEVER writes (no database, no log): this way it cannot be amplified by
 * a flood of requests. Real anti-DoS protection belongs to the infrastructure
 * layer (reverse proxy rate limiting), not here.
 *
 * Notes:
 * - The class is NOT final: the Dinamic system generates a subclass that extends
 *   it (Core/Internal/PluginsDeploy), so marking it final would be a fatal error.
 * - The Kernel auto-registers every file under Dinamic/Controller as a route
 *   named after the class, so this endpoint is reachable at /AppPing without
 *   touching Init.php and without generating any menu entry (getPageData = []).
 *
 * @author Jose Antonio Cuello Principal <yopli2000@gmail.com>
 */
class AppPing implements ControllerInterface
{
    public function __construct(string $className, string $url = '')
    {
    }

    public function getPageData(): array
    {
        return [];
    }

    public function run(): void
    {
        // 204 No Content, no body, never cached.
        (new Response(204))
            ->header('Cache-Control', 'no-store')
            ->send();
    }
}
