#!/usr/bin/perl
# Native messaging host for the Mesh LLM browser extension.
#
# Chrome launches this per message (sendNativeMessage). It reads one
# length-prefixed JSON message on stdin, does a fixed, allow-listed action,
# writes one JSON reply, and exits. mesh-llm itself is started fully
# detached (fork + setsid) so it outlives this process and the browser.
#
# Only uses core Perl modules shipped with macOS (/usr/bin/perl).
use strict;
use warnings;
use POSIX qw(setsid WNOHANG);
use JSON::PP;
use File::Path qw(make_path);

my $HOME     = $ENV{HOME} || (getpwuid($<))[7];
my $BASE     = "$HOME/.mesh-llm-browser";
my $BUNDLE   = "$BASE/bundle";
my $BIN      = "$BUNDLE/mesh-llm";
my $PIDFILE  = "$BASE/mesh-llm.pid";
my $LOG      = "$BASE/mesh-llm.log";
my $VERSION  = "0.2.0";
my $EXT_REPO = "Mesh-LLM/browser-extension";
my $REPO     = "Mesh-LLM/mesh-llm";
my $ASSET    = "mesh-llm-aarch64-apple-darwin.tar.gz";

make_path($BASE);
$ENV{PATH} = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";

my $json = JSON::PP->new->utf8->canonical;

sub read_msg {
    binmode STDIN;
    my $n = read(STDIN, my $len, 4);
    return undef unless defined $n && $n == 4;
    my $size = unpack('V', $len);
    return undef if $size > 1024 * 1024;
    my $buf = '';
    while (length($buf) < $size) {
        my $r = read(STDIN, my $chunk, $size - length($buf));
        last unless $r;
        $buf .= $chunk;
    }
    return $json->decode($buf);
}

sub send_msg {
    my ($obj) = @_;
    my $out = $json->encode($obj);
    binmode STDOUT;
    local $| = 1;
    print STDOUT pack('V', length($out)) . $out;
}

sub running_pid {
    open(my $fh, '<', $PIDFILE) or return 0;
    my $pid = <$fh>;
    close $fh;
    return 0 unless defined $pid && $pid =~ /^(\d+)/;
    $pid = $1;
    return 0 unless kill(0, $pid);
    # Make sure the pid still belongs to mesh-llm (pid reuse).
    my $cmd = `ps -p $pid -o comm= 2>/dev/null`;
    return ($cmd =~ /mesh-llm/) ? $pid : 0;
}

sub bin_version {
    return undef unless -x $BIN;
    my $v = `"$BIN" --version 2>/dev/null`;
    chomp $v;
    $v =~ s/^mesh-llm\s+//;
    return $v || undef;
}

# Settings -> argv, mirroring the Mesh desktop app (Mesh-LLM/mesh-app):
#   public  + share   : serve --auto [--model M]
#   public  + noshare : client --auto
#   private (create)  : serve --owner-required --trust-policy require-owned --min-node-version 0.76.0
#   private (join)    : serve --owner-required --trust-policy require-owned --join-file <invite>
#   private + noshare : ... --client
# The extension only ever sends these fields; never a command line.
my $MIN_NODE_VERSION = '0.76.0';
my $INVITE = "$BASE/invite.txt";

sub build_args {
    my ($opts) = @_;
    my $conn  = $opts->{connection} // 'public';
    my $share = exists $opts->{share} ? ($opts->{share} ? 1 : 0) : 1;
    my $model = $opts->{model} // '';
    die "invalid model name\n" if $model ne '' && $model !~ m{^[A-Za-z0-9_.:/@\-]{1,200}$};

    my @args;
    if ($conn eq 'public') {
        @args = $share ? ('serve', '--auto') : ('client', '--auto');
    } elsif ($conn eq 'private') {
        @args = ('serve', '--owner-required', '--trust-policy', 'require-owned');
        my $tok = $opts->{invite} // '';
        if ($tok ne '') {
            die "Paste the complete Mesh invite, without spaces or a command.\n"
                unless $tok =~ /^[A-Za-z0-9_\-]{16,32768}$/;
            open(my $fh, '>', $INVITE) or die "invite file: $!\n";
            chmod 0600, $INVITE;
            print $fh $tok; close $fh;
            push @args, '--join-file', $INVITE;
        } else {
            push @args, '--min-node-version', $MIN_NODE_VERSION;
        }
        push @args, '--client' unless $share;
    } else {
        die "unknown connection '$conn'\n";
    }
    push @args, '--model', $model if $share && $model ne '';
    return @args;
}

# Private meshes need an owner identity. Create one (passphrase kept in the
# macOS Keychain) only if this machine has none; never replace an existing one.
sub ensure_owner {
    return if -f "$HOME/.mesh-llm/owner-keystore.json";
    my $out = `"$BIN" auth init --keychain 2>&1`;
    die "could not create owner identity: $out\n" if $? != 0;
}

# Anything already listening on the mesh ports? (Started outside the extension.)
sub port_owner {
    for my $port (3131, 9337) {
        my $pid = `lsof -nP -t -iTCP:$port -sTCP:LISTEN 2>/dev/null`;
        $pid =~ s/\s.*//s;
        return ($pid, $port) if $pid =~ /^\d+$/;
    }
    return ();
}

sub do_start {
    my ($opts) = @_;
    if (my $pid = running_pid()) {
        return { ok => JSON::PP::true, already_running => JSON::PP::true, pid => $pid };
    }
    die "mesh-llm not installed at $BIN — run install.sh\n" unless -x $BIN;
    if (my ($opid, $oport) = port_owner()) {
        return { ok => JSON::PP::true, already_running => JSON::PP::true, external => JSON::PP::true, pid => $opid + 0, port => $oport };
    }
    my @args = build_args($opts);
    ensure_owner() if ($opts->{connection} // '') eq 'private';
    if (open(my $lf, ">", "$BASE/last-opts.json")) { my %o = %$opts; $o{invite} = $o{invite} ? 'set' : ''; print $lf $json->encode(\%o); close $lf; }

    pipe(my $r, my $w) or die "pipe: $!";
    my $pid = fork();
    die "fork: $!" unless defined $pid;
    if ($pid == 0) {
        # First child: new session, then fork again so we are not a session
        # leader and get reparented to launchd.
        close $r;
        setsid();
        my $pid2 = fork();
        exit 1 unless defined $pid2;
        if ($pid2) {
            print $w "$pid2\n";
            close $w;
            POSIX::_exit(0);
        }
        close $w;
        chdir $BUNDLE;
        open(STDIN,  '<',  '/dev/null');
        open(STDOUT, '>>', $LOG);
        open(STDERR, '>&', \*STDOUT);
        $ENV{NO_COLOR} = '1';
        print STDOUT "\n===== browser launch " . scalar(localtime) . ": mesh-llm @args" . " =====\n";
        exec { $BIN } $BIN, @args or POSIX::_exit(127);
    }
    close $w;
    my $child = <$r>;
    close $r;
    waitpid($pid, 0);
    chomp $child if defined $child;
    die "failed to launch mesh-llm\n" unless $child && $child =~ /^\d+$/;

    open(my $fh, '>', $PIDFILE) or die "pidfile: $!";
    print $fh "$child\n";
    close $fh;

    sleep 1;
    die "mesh-llm exited immediately — see log\n" . tail_log(20) unless kill(0, $child);
    return { ok => JSON::PP::true, pid => $child, args => \@args };
}

sub do_stop {
    my ($want) = @_;
    my $pid = running_pid();
    if (!$pid && $want && $want =~ /^\d+$/) {
        my $cmd = `ps -p $want -o comm= 2>/dev/null`;
        die "pid $want is not mesh-llm\n" unless $cmd =~ /mesh-llm/;
        $pid = $want;
    }
    unless ($pid) { unlink $PIDFILE; return { ok => JSON::PP::true, was_running => JSON::PP::false }; }
    kill('TERM', $pid);
    for (1 .. 300) { last unless kill(0, $pid); select(undef, undef, undef, 0.1); }
    kill('KILL', $pid) if kill(0, $pid);
    unlink $PIDFILE;
    return { ok => JSON::PP::true, was_running => JSON::PP::true, pid => $pid };
}

sub tail_log {
    my ($n) = @_;
    return '' unless -f $LOG;
    my $out = `tail -n $n "$LOG" 2>/dev/null`;
    $out =~ s/\e\[[0-9;]*m//g;   # strip ANSI
    return $out;
}

sub last_opts {
    open(my $fh, "<", "$BASE/last-opts.json") or return { connection => "public", share => 1 };
    local $/; my $d = <$fh>; close $fh;
    return eval { $json->decode($d) } || { connection => "public", share => 1 };
}

# Refresh the extension files and this launcher from the GitHub repo. The
# extension is loaded unpacked from $BASE/extension, so replacing its files in
# place and calling chrome.runtime.reload() is a full update.
sub update_extension {
    my $tmp = "$BASE/ext.$$";
    make_path($tmp);
    my $ok = system("curl -fsSL 'https://codeload.github.com/$EXT_REPO/tar.gz/main' | tar -xz -C '$tmp'") == 0;
    my ($src) = glob("$tmp/*/extension/manifest.json");
    unless ($ok && $src) { system('rm', '-rf', $tmp); die "could not download github.com/$EXT_REPO\n"; }
    $src =~ s{/extension/manifest.json$}{};
    system('perl', '-c', "$src/native-host/mesh-llm-host.pl") == 0 or die "downloaded launcher is broken\n";
    make_path("$BASE/extension");
    system('rsync', '-a', '--delete', "$src/extension/", "$BASE/extension/") == 0 or die "extension update failed\n";
    system('cp', "$src/native-host/mesh-llm-host.pl", "$BASE/mesh-llm-host.pl.new") == 0 or die "launcher update failed\n";
    chmod 0755, "$BASE/mesh-llm-host.pl.new";
    rename("$BASE/mesh-llm-host.pl.new", "$BASE/mesh-llm-host.pl");
    system('rm', '-rf', $tmp);
    return 1;
}

sub do_update {
    my ($binary_only) = @_;
    my $was = running_pid();
    do_stop() if $was;
    my $api = "https://api.github.com/repos/$REPO/releases?per_page=20";
    my $resp = `curl -fsSL -H 'Accept: application/vnd.github+json' '$api'`;
    die "could not query GitHub releases\n" unless $resp;
    my $rels = $json->decode($resp);
    my ($rel) = grep { $_->{prerelease} && !$_->{draft} } @$rels;
    die "no preview release found\n" unless $rel;
    my $tag = $rel->{tag_name};
    my $url = "https://github.com/$REPO/releases/download/$tag/$ASSET";
    my $tmp = "$BASE/dl.$$";
    make_path($tmp);
    system('curl', '-fsSL', '-o', "$tmp/m.tgz", $url) == 0 or die "download failed: $url\n";
    system('curl', '-fsSL', '-o', "$tmp/m.tgz.sha256", "$url.sha256");
    if (-s "$tmp/m.tgz.sha256") {
        my ($want) = split(/\s+/, `cat "$tmp/m.tgz.sha256"`);
        my ($got)  = split(/\s+/, `shasum -a 256 "$tmp/m.tgz"`);
        die "checksum mismatch\n" unless lc($want) eq lc($got);
    }
    system('tar', '-xzf', "$tmp/m.tgz", '-C', $tmp) == 0 or die "extract failed\n";
    die "unexpected archive layout\n" unless -x "$tmp/mesh-bundle/mesh-llm";
    system('rm', '-rf', "$BUNDLE.old");
    rename($BUNDLE, "$BUNDLE.old") if -d $BUNDLE;
    rename("$tmp/mesh-bundle", $BUNDLE) or die "install failed: $!\n";
    system('xattr', '-dr', 'com.apple.quarantine', $BUNDLE);
    system('rm', '-rf', $tmp, "$BUNDLE.old");
    my $res = { ok => JSON::PP::true, tag => $tag, version => bin_version() };
    $res->{extension_updated} = update_extension() ? JSON::PP::true : JSON::PP::false unless $binary_only;
    if ($was) {
        my $o = last_opts();
        if (($o->{invite} // '') eq 'set' && -f $INVITE) { open(my $f, '<', $INVITE); local $/; $o->{invite} = <$f>; close $f; } else { $o->{invite} = ''; }
        $res->{restarted} = do_start($o);
    }
    return $res;
}

my $msg = eval { read_msg() };
unless ($msg) { send_msg({ ok => JSON::PP::false, error => 'bad message' }); exit 0; }

my $cmd = $msg->{cmd} // '';
my $reply = eval {
    if    ($cmd eq 'ping')   { { ok => JSON::PP::true, host_version => $VERSION } }
    elsif ($cmd eq 'status') {
        my $pid = running_pid();
        {
            ok           => JSON::PP::true,
            host_version => $VERSION,
            installed    => (-x $BIN ? JSON::PP::true : JSON::PP::false),
            version      => bin_version(),
            managed_pid  => ($pid || undef),
            crashed      => ((!$pid && -f $PIDFILE) ? JSON::PP::true : JSON::PP::false),
            log_tail     => ((!$pid && -f $PIDFILE) ? tail_log(25) : undef),
            bin          => $BIN,
            log          => $LOG,
        }
    }
    elsif ($cmd eq 'start')  { do_start($msg->{opts} || {}) }
    elsif ($cmd eq 'stop')   { do_stop($msg->{pid}) }
    elsif ($cmd eq 'restart') {
        do_stop($msg->{pid});
        for (1 .. 40) { last unless port_owner(); select(undef, undef, undef, 0.25); }
        do_start($msg->{opts} || {})
    }
    elsif ($cmd eq 'args')   { { ok => JSON::PP::true, args => [build_args($msg->{opts} || {})] } }
    elsif ($cmd eq 'logs')   { { ok => JSON::PP::true, text => tail_log(int($msg->{lines} || 80)) } }
    elsif ($cmd eq 'update') { do_update($msg->{binary_only}) }
    else                     { die "unknown cmd '$cmd'\n" }
};
if ($@) { my $e = $@; chomp $e; $reply = { ok => JSON::PP::false, error => $e }; }
send_msg($reply);
exit 0;
